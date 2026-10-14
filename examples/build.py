"""실제 조직과 관계없는 합성 사례: 장애 대응 절차의 실패와 정정."""
import copy
import json
from pathlib import Path

from reference.model import apply, empty, text_hash

TIME = "2026-01-01T00:00:00Z"
CONTEXT = {"scope": "synthetic-service", "condition": "일반 요청량이며 진단에 사용할 수 있는 상태 정보가 존재한다", "valid_from": None, "valid_until": None}


def input_(id_, text, group=None):
    return {"id": id_, "revision": 1, "text": text, "sha256": text_hash(text), "source": "urn:example:simulation", "origin_group": group, "observed_at": TIME, "recorded_at": TIME, "state": "available"}


def memory(id_, text, kind="belief"):
    return {"id": id_, "revision": 1, "text": text, "kind": kind, "context": copy.deepcopy(CONTEXT), "state": "current", "review_required": True, "review": None}


def selector(original):
    return {"input_id": original["id"], "sha256": original["sha256"], "start": 0, "end": len(original["text"]), "quote": original["text"]}


def link(id_, source, target, type_, original, context=None):
    return {"id": id_, "revision": 1, "source": source, "target": target, "type": type_, "context": copy.deepcopy(context or CONTEXT), "state": "current", "basis": [selector(original)], "review": {"actor": "urn:example:reviewer", "reason": "합성 시험의 구간과 적용 조건을 확인했다"}}


def change(id_, revision, operations):
    return {"request_id": id_, "expected_revision": revision, "actor": "urn:example:reviewer", "reason": "합성 시험 기록을 반영한다", "recorded_at": TIME, "operations": operations}


def put(collection, record):
    return {"op": "put", "collection": collection, "record": record}


def initial():
    original = input_("urn:example:input:trial-1", "시험 1: 상태를 먼저 확인한 뒤 복구 절차를 선택해 서비스를 복구했다.", "urn:example:event:trial-1")
    hypothesis = memory("urn:example:memory:diagnose", "이 조건에서는 상태를 먼저 확인한 뒤 복구 절차를 선택하는 것이 유효하다.")
    procedure = memory("urn:example:memory:procedure", "복구 절차를 선택하기 전에 현재 상태 정보를 확인한다.", "procedure")
    operations = [put("inputs", original), put("memories", hypothesis), put("memories", procedure), put("links", link("urn:example:link:trial-1", original["id"], hypothesis["id"], "supports", original)), put("links", link("urn:example:link:requires", procedure["id"], hypothesis["id"], "requires", original))]
    return apply(empty(), change("urn:example:request:initial", 0, operations), {})[:2]


if __name__ == "__main__":
    snapshot, _ = initial()
    Path(__file__).with_name("snapshot.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
