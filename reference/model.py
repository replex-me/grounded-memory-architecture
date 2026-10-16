"""공개 초안의 교환 검사와 순수 전이 예제. 운영 저장·인증 엔진이 아니다."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "schema/model.schema.json").read_text())
FORMAT = FormatChecker()


@FORMAT.checks("date-time")
def check_time(value):
    if not isinstance(value, str):
        return True
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})", value):
        return False
    try:
        if value.endswith("-00:00"):
            return False
        datetime.fromisoformat(value.upper().replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FORMAT)
CHANGE_SCHEMA = json.loads((ROOT / "schema/change.schema.json").read_text())
REGISTRY = Registry().with_resource(SCHEMA["$id"], Resource.from_contents(SCHEMA))
CHANGE_VALIDATOR = Draft202012Validator(CHANGE_SCHEMA, registry=REGISTRY, format_checker=FORMAT)


class Invalid(ValueError):
    pass


def encoded(value):
    def check(item):
        if item is None or isinstance(item, bool):
            return item
        if isinstance(item, int) and abs(item) <= 9007199254740991:
            return item
        if isinstance(item, float) and math.isfinite(item) and item.is_integer() and abs(item) <= 9007199254740991:
            return int(item)
        if isinstance(item, str):
            item.encode("utf-8")
            return item
        if isinstance(item, list):
            return [check(child) for child in item]
        if isinstance(item, dict) and all(isinstance(key, str) for key in item):
            return {check(key): check(child) for key, child in item.items()}
        raise Invalid("참조 프로파일에는 안전한 정수와 JSON 값만 허용한다")
    return json.dumps(check(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


def text_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def empty():
    return {"format": "memory-architecture/0.1", "revision": 0, "inputs": [], "memories": [], "links": []}


def index(snapshot):
    return {record["id"]: record for key in ("inputs", "memories", "links") for record in snapshot[key]}


def dependencies(snapshot):
    """결론→전제. 출처를 포함하며 단순 탐색 관계를 제외한다."""
    result = {}
    for link in snapshot["links"]:
        if link["state"] != "current" or link["type"] == "related":
            continue
        dependent, basis = (link["source"], link["target"]) if link["type"] == "requires" else (link["target"], link["source"])
        result.setdefault(dependent, set()).add(basis)
    return result


def closure(snapshot, memory_id):
    dep, visited, pending = dependencies(snapshot), set(), [memory_id]
    while pending:
        item = pending.pop()
        if item not in visited:
            visited.add(item)
            pending.extend(dep.get(item, ()))
    return visited


def review_token(snapshot, memory_id):
    records, nodes = index(snapshot), closure(snapshot, memory_id)
    if memory_id not in {m["id"] for m in snapshot["memories"]}:
        raise Invalid("검토 대상 기억이 없다")
    links = []
    for link in snapshot["links"]:
        if link["type"] == "related":
            continue
        dependent = link["source"] if link["type"] == "requires" else link["target"]
        if dependent in nodes:
            links.append(copy.deepcopy(link))
            nodes.update(b["input_id"] for b in link["basis"])
    selected = []
    for id_ in sorted(nodes):
        record = copy.deepcopy(records[id_])
        record.pop("review", None)
        if id_ == memory_id:
            record.pop("review_required", None)
        selected.append(record)
    return digest({"profile": "memory-architecture/0.1", "nodes": selected, "links": sorted(links, key=lambda x: x["id"])})


def validate(snapshot):
    errors = sorted(VALIDATOR.iter_errors(snapshot), key=lambda e: str(list(e.path)))
    if errors:
        raise Invalid("형식 오류: " + errors[0].message)
    try:
        encoded(snapshot).encode("utf-8")
    except UnicodeError as error:
        raise Invalid("유효한 Unicode scalar 값이 필요하다") from error
    records = index(snapshot)
    if len(records) != sum(len(snapshot[k]) for k in ("inputs", "memories", "links")):
        raise Invalid("중복 식별자")
    inputs = {r["id"]: r for r in snapshot["inputs"]}
    memories = {r["id"]: r for r in snapshot["memories"]}
    for record in inputs.values():
        if record["sha256"] != text_hash(record["text"]):
            raise Invalid("원본 해시 불일치")
    for record in list(memories.values()) + snapshot["links"]:
        context = record["context"]
        if context["valid_from"] and context["valid_until"] and datetime.fromisoformat(context["valid_from"].upper().replace("Z", "+00:00")) >= datetime.fromisoformat(context["valid_until"].upper().replace("Z", "+00:00")):
            raise Invalid("유효 기간 순서 오류")
    for link in snapshot["links"]:
        source, target = link["source"], link["target"]
        if source in inputs:
            if target not in memories or link["type"] not in {"context", "supports", "opposes"}:
                raise Invalid("원본 연결 경계 위반")
            if not link["basis"] or any(b["input_id"] != source for b in link["basis"]):
                raise Invalid("직접 원본 연결에는 해당 원본 구간이 필요하다")
        elif source in memories:
            if target not in memories or source == target or link["type"] == "context":
                raise Invalid("기억 연결 경계 위반")
        else:
            raise Invalid("연결 출발점이 없다")
        if link["state"] == "current" and link["review"] is None:
            raise Invalid("현재 연결에는 검토자와 이유가 필요하다")
        if source in memories and link["type"] != "related" and link["state"] == "current" and not link["basis"]:
            raise Invalid("판단 관계에는 원본 근거가 필요하다")
        for basis in link["basis"]:
            original = inputs.get(basis["input_id"])
            if original is None or original["sha256"] != basis["sha256"]:
                raise Invalid("근거 원본 불일치")
            if not 0 <= basis["start"] < basis["end"] <= len(original["text"]) or original["text"][basis["start"]:basis["end"]] != basis["quote"]:
                raise Invalid("근거 구간 불일치")
    for memory in memories.values():
        if memory["state"] == "current" and not memory["review_required"]:
            if memory["review"] is None or memory["review"]["token"] != review_token(snapshot, memory["id"]):
                raise Invalid("검토가 없거나 최신 근거와 불일치")
            for basis_id in closure(snapshot, memory["id"]) - {memory["id"]}:
                basis = memories.get(basis_id)
                if basis and (basis["review_required"] or basis["state"] != "current"):
                    raise Invalid("현재 검토가 미검토 전제에 의존한다")
    return snapshot


def evidence_counts(snapshot, memory_id):
    validate(snapshot)
    records, target = index(snapshot), index(snapshot)[memory_id]
    groups = {"supports": set(), "opposes": set()}
    for link in snapshot["links"]:
        if link["target"] != memory_id or link["state"] != "current" or link["type"] not in groups or link["context"] != target["context"]:
            continue
        source = records[link["source"]]
        if source in snapshot["inputs"] and source["state"] == "available" and source["origin_group"]:
            groups[link["type"]].add(source["origin_group"])
    conflict = groups["supports"] & groups["opposes"]
    return {"support_groups": sorted(groups["supports"] - conflict), "opposition_groups": sorted(groups["opposes"] - conflict), "conflict_groups": sorted(conflict)}


def impacted(before, after, changed):
    reverse = {}
    for snapshot in (before, after):
        for dependent, bases in dependencies(snapshot).items():
            for basis in bases:
                reverse.setdefault(basis, set()).add(dependent)
        for link in snapshot["links"]:
            if link["state"] == "current" and link["type"] != "related":
                dependent = link["source"] if link["type"] == "requires" else link["target"]
                for basis in link["basis"]:
                    reverse.setdefault(basis["input_id"], set()).add(dependent)
    visited, pending = set(), list(changed)
    while pending:
        item = pending.pop()
        if item not in visited:
            visited.add(item)
            pending.extend(reverse.get(item, ()))
    return visited


def apply(snapshot, change, receipts):
    """출력만 새로 반환한다. 실패 시 원래 snapshot/receipts는 바뀌지 않는다."""
    validate(snapshot)
    error = next(CHANGE_VALIDATOR.iter_errors(change), None)
    if error:
        raise Invalid("변경 형식 오류: " + error.message)
    if not all(change[k].strip() for k in ("request_id", "actor", "reason", "recorded_at")):
        raise Invalid("변경 계약 위반")
    request_hash = digest(change)
    if change["request_id"] in receipts:
        saved = receipts[change["request_id"]]
        if saved["request_hash"] != request_hash:
            raise Invalid("같은 요청 식별자의 다른 내용")
        return copy.deepcopy(snapshot), copy.deepcopy(receipts), copy.deepcopy(saved)
    if change["expected_revision"] != snapshot["revision"]:
        raise Invalid("동시 수정 충돌")
    after, changed, reviews, touched = copy.deepcopy(snapshot), set(), [], set()
    for op in change["operations"]:
        if not isinstance(op, dict) or "op" not in op:
            raise Invalid("작업 형식 오류")
        if op["op"] == "put":
            if set(op) != {"op", "collection", "record"} or op["collection"] not in {"inputs", "memories", "links"}:
                raise Invalid("등록 작업 오류")
            key, record = op["collection"], copy.deepcopy(op["record"])
            fragment = {"$schema": SCHEMA["$schema"], "$defs": SCHEMA["$defs"], "$ref": "#/$defs/" + {"inputs": "input", "memories": "memory", "links": "link"}[key]}
            error = next(Draft202012Validator(fragment, format_checker=FORMAT).iter_errors(record), None)
            if error:
                raise Invalid("기록 형식 오류: " + error.message)
            if not isinstance(record, dict) or "id" not in record:
                raise Invalid("기록 식별자 누락")
            id_ = record["id"]
            if id_ in touched:
                raise Invalid("동일 변경에서 중복 수정")
            touched.add(id_)
            previous = next((r for r in after[key] if r["id"] == id_), None)
            if record.get("revision") != (previous["revision"] + 1 if previous else 1):
                raise Invalid("기록 버전 오류")
            if key == "inputs" and previous:
                raise Invalid("원본 덮어쓰기 금지")
            if key == "memories":
                record["review_required"], record["review"] = True, None
            after[key] = [r for r in after[key] if r["id"] != id_] + [record]
            changed.add(id_)
            if key == "links":
                for link in (previous, record):
                    if link and link["type"] != "related":
                        changed.add(link["source"] if link["type"] == "requires" else link["target"])
        elif op["op"] == "withdraw_input":
            if set(op) != {"op", "id"} or op["id"] in touched:
                raise Invalid("철회 작업 오류")
            touched.add(op["id"])
            record = next((r for r in after["inputs"] if r["id"] == op["id"]), None)
            if not record or record["state"] == "withdrawn":
                raise Invalid("철회 가능한 원본이 없다")
            record["state"], record["revision"] = "withdrawn", record["revision"] + 1
            changed.add(record["id"])
        elif op["op"] == "review":
            if set(op) != {"op", "id", "token", "reason"} or not isinstance(op["reason"], str) or not op["reason"].strip():
                raise Invalid("검토 작업 오류")
            reviews.append(op)
        else:
            raise Invalid("알 수 없는 작업")
    if reviews and (changed or len({r["id"] for r in reviews}) != len(reviews)):
        raise Invalid("검토는 변경 없는 별도 요청에서 중복 없이 처리한다")
    affected = impacted(snapshot, after, changed)
    for memory in after["memories"]:
        if memory["id"] in affected:
            memory["review_required"] = True
    # 이전 최신성 토큰이 달라진 경우 근거 집합의 변화도 전파한다.
    for memory in after["memories"]:
        if memory["review"] and memory["review"]["token"] != review_token(after, memory["id"]):
            memory["review_required"] = True
    review_ids = {op["id"] for op in reviews}
    for op in reviews:
        memory = next((r for r in after["memories"] if r["id"] == op["id"]), None)
        if not memory or memory["state"] != "current" or review_token(after, op["id"]) != op["token"]:
            raise Invalid("검토 대상 또는 최신성 토큰 오류")
        for basis_id in closure(after, op["id"]) - review_ids:
            basis = index(after)[basis_id]
            if basis in after["memories"] and (basis["review_required"] or basis["state"] != "current"):
                raise Invalid("미검토 전제를 현재 근거로 사용할 수 없다")
    for op in reviews:
        memory = next(r for r in after["memories"] if r["id"] == op["id"])
        memory["review_required"] = False
    for op in reviews:
        memory = next(r for r in after["memories"] if r["id"] == op["id"])
        memory["review"] = {"actor": change["actor"], "reason": op["reason"], "token": review_token(after, op["id"])}
        # 중간 전제의 검토 상태 변화도 의존 결론의 토큰에 반영한다.
        for dependent in after["memories"]:
            if dependent["id"] not in review_ids and dependent["review"] and dependent["review"]["token"] != review_token(after, dependent["id"]):
                dependent["review_required"] = True
    after["revision"] += 1
    validate(after)
    result = {"request_id": change["request_id"], "request_hash": request_hash, "revision": after["revision"], "actor": change["actor"], "reason": change["reason"], "recorded_at": change["recorded_at"], "operations": copy.deepcopy(change["operations"]), "affected": sorted(affected)}
    saved = copy.deepcopy(receipts)
    saved[change["request_id"]] = result
    return after, saved, result


if __name__ == "__main__":
    import sys
    try:
        validate(json.loads(Path(sys.argv[1]).read_text()))
        print("교환 파일 적합성 검사 통과")
    except (Invalid, KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
