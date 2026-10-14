"""실행 가능 예제. 근거 수와 재검토 상태를 보여주며 확률은 만들지 않는다."""
import json

from examples.build import initial, input_, link, change, put
from reference.model import apply, evidence_counts, review_token

H = "urn:example:memory:diagnose"
P = "urn:example:memory:procedure"


def run():
    snapshot, receipts = initial()
    events = []

    def report(label):
        events.append({"stage": label, "revision": snapshot["revision"], **evidence_counts(snapshot, H), "review_required": {m["id"]: m["review_required"] for m in snapshot["memories"]}})

    def commit(id_, operations):
        nonlocal snapshot, receipts
        snapshot, receipts, _ = apply(snapshot, change(id_, snapshot["revision"], operations), receipts)

    report("원본에서 두 기억과 관계를 형성")
    for id_ in (H, P):
        commit("review-" + id_, [{"op": "review", "id": id_, "token": review_token(snapshot, id_), "reason": "원본과 전제를 검토했다"}])
    report("현재 판단 검토 완료")
    repeat = input_("urn:example:input:summary", "시험 1의 결과를 다시 요약했다.", "urn:example:event:trial-1")
    commit("repeat", [put("inputs", repeat), put("links", link("repeat", repeat["id"], H, "supports", repeat))])
    report("재인용은 독립 근거를 늘리지 않음")
    failure = input_("urn:example:input:failure", "시험 2: 같은 조건에서 상태 확인 결과가 잘못되어 복구에 실패했다.", "urn:example:event:trial-2")
    commit("failure", [put("inputs", failure), put("links", link("failure", failure["id"], H, "opposes", failure))])
    report("새 반례가 판단과 의존 절차의 재검토를 요구")
    commit("withdraw", [{"op": "withdraw_input", "id": failure["id"]}])
    report("측정 오류로 반례 원본 철회; 재검토는 유지")
    return events


if __name__ == "__main__":
    print(json.dumps(run(), ensure_ascii=False, indent=2))
