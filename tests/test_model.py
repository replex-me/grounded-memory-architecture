import copy
import unittest

from examples.build import initial, input_, memory, selector, link, change, put
from reference.model import Invalid, apply, digest, evidence_counts, review_token, text_hash, validate

H = "urn:example:memory:diagnose"
P = "urn:example:memory:procedure"


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.snapshot, self.receipts = initial()

    def transact(self, operations, id_=None):
        request = change(id_ or "next-" + str(self.snapshot["revision"]), self.snapshot["revision"], operations)
        self.snapshot, self.receipts, result = apply(self.snapshot, request, self.receipts)
        return result

    def review(self, *ids):
        return self.transact([{"op": "review", "id": id_, "token": review_token(self.snapshot, id_), "reason": "원문과 조건 및 전제를 검토했다"} for id_ in ids], "review-" + str(self.snapshot["revision"]))

    def test_valid_example(self):
        validate(self.snapshot)
        self.assertEqual(evidence_counts(self.snapshot, H)["support_groups"], ["urn:example:event:trial-1"])

    def test_input_to_input_forbidden(self):
        bad = copy.deepcopy(self.snapshot)
        bad["links"][0]["target"] = bad["inputs"][0]["id"]
        with self.assertRaises(Invalid):
            validate(bad)

    def test_memory_to_input_forbidden(self):
        bad = copy.deepcopy(self.snapshot)
        bad["links"][1]["target"] = bad["inputs"][0]["id"]
        with self.assertRaises(Invalid):
            validate(bad)

    def test_hash_and_selector_check(self):
        for mutation in ("hash", "quote", "range"):
            with self.subTest(mutation=mutation):
                bad = copy.deepcopy(self.snapshot)
                if mutation == "hash":
                    bad["inputs"][0]["text"] += "변조"
                elif mutation == "quote":
                    bad["links"][0]["basis"][0]["quote"] = "다른 문장"
                else:
                    bad["links"][0]["basis"][0]["end"] += 1
                with self.assertRaises(Invalid):
                    validate(bad)

    def test_unicode_codepoints(self):
        original = input_("emoji", "가😀나", "emoji-event")
        relation = link("emoji-link", "emoji", H, "context", original)
        relation["basis"][0].update(start=1, end=2, quote="😀")
        self.transact([put("inputs", original), put("links", relation)])
        validate(self.snapshot)

    def test_repeated_citation_not_independent(self):
        original = input_("repeat", "시험 1의 결과를 다시 요약했다.", "urn:example:event:trial-1")
        self.transact([put("inputs", original), put("links", link("repeat-link", "repeat", H, "supports", original))])
        self.assertEqual(len(evidence_counts(self.snapshot, H)["support_groups"]), 1)

    def test_unknown_independence_not_counted(self):
        original = input_("unknown", "성공했다는 소식이다.")
        self.transact([put("inputs", original), put("links", link("unknown-link", "unknown", H, "supports", original))])
        self.assertEqual(len(evidence_counts(self.snapshot, H)["support_groups"]), 1)

    def test_other_condition_not_counted(self):
        original = input_("different", "정보를 읽을 수 없는 조건에서 실패했다.", "different-event")
        relation = link("different-link", "different", H, "opposes", original)
        relation["context"]["condition"] = "상태 정보가 존재하지 않는다"
        self.transact([put("inputs", original), put("links", relation)])
        self.assertEqual(evidence_counts(self.snapshot, H)["opposition_groups"], [])

    def test_conflicting_event_visible(self):
        original = self.snapshot["inputs"][0]
        self.transact([put("links", link("conflict", original["id"], H, "opposes", original))])
        counts = evidence_counts(self.snapshot, H)
        self.assertEqual(counts["support_groups"], [])
        self.assertEqual(counts["conflict_groups"], [original["origin_group"]])

    def test_review_and_indirect_invalidation(self):
        self.review(H)
        self.review(P)
        original = input_("failure", "같은 조건에서 확인 절차의 결과가 잘못되어 복구가 실패했다.", "failure-event")
        result = self.transact([put("inputs", original), put("links", link("failure-link", "failure", H, "opposes", original))])
        self.assertIn(P, result["affected"])
        self.assertTrue(all(m["review_required"] for m in self.snapshot["memories"]))
        self.assertEqual(evidence_counts(self.snapshot, H)["opposition_groups"], ["failure-event"])

    def test_review_stale_premise_rejected(self):
        with self.assertRaises(Invalid):
            self.review(P)

    def test_unrelated_link_does_not_invalidate(self):
        self.review(H)
        self.review(P)
        original = self.snapshot["inputs"][0]
        self.transact([put("links", link("related", H, P, "related", original))])
        self.assertFalse(any(m["review_required"] for m in self.snapshot["memories"]))

    def test_source_withdrawal_cancels_counts(self):
        self.review(H)
        self.review(P)
        self.transact([{"op": "withdraw_input", "id": self.snapshot["inputs"][0]["id"]}])
        self.assertEqual(evidence_counts(self.snapshot, H)["support_groups"], [])
        self.assertTrue(all(m["review_required"] for m in self.snapshot["memories"]))

    def test_link_withdrawal_reopens_review(self):
        self.review(H)
        self.review(P)
        relation = copy.deepcopy(self.snapshot["links"][0])
        relation.update(revision=2, state="withdrawn")
        self.transact([put("links", relation)])
        self.assertTrue(all(m["review_required"] for m in self.snapshot["memories"]))

    def test_input_immutable_and_failure_atomic(self):
        original = copy.deepcopy(self.snapshot["inputs"][0])
        original.update(revision=2, text="덮어쓰기")
        original["sha256"] = text_hash(original["text"])
        before, saved = digest(self.snapshot), copy.deepcopy(self.receipts)
        with self.assertRaises(Invalid):
            self.transact([put("memories", memory("new", "새 기억")), put("inputs", original)])
        self.assertEqual(digest(self.snapshot), before)
        self.assertEqual(self.receipts, saved)

    def test_duplicate_request_returns_receipt(self):
        request = change("retry", self.snapshot["revision"], [put("memories", memory("new", "새 기억"))])
        after, receipts, result = apply(self.snapshot, request, self.receipts)
        again, receipts2, result2 = apply(after, request, receipts)
        self.assertEqual(again, after)
        self.assertEqual(receipts2, receipts)
        self.assertEqual(result2, result)
        request["reason"] = "다른 내용"
        with self.assertRaises(Invalid):
            apply(after, request, receipts)

    def test_revision_conflict(self):
        request = change("conflict", 0, [put("memories", memory("new", "새 기억"))])
        with self.assertRaises(Invalid):
            apply(self.snapshot, request, self.receipts)

    def test_new_dependency_changes_review_token(self):
        self.review(H)
        token = review_token(self.snapshot, H)
        original = self.snapshot["inputs"][0]
        self.transact([put("memories", memory("new", "새 전제")), put("links", link("new-basis", H, "new", "requires", original))])
        self.assertNotEqual(token, review_token(self.snapshot, H))

    def test_cycle_terminates_and_group_review(self):
        original = self.snapshot["inputs"][0]
        self.transact([put("links", link("cycle", H, P, "requires", original))])
        self.review(H, P)
        self.assertFalse(any(m["review_required"] for m in self.snapshot["memories"]))
        self.transact([{"op": "withdraw_input", "id": original["id"]}])
        self.assertTrue(all(m["review_required"] for m in self.snapshot["memories"]))

    def test_unreviewed_relation_and_unknown_fields_rejected(self):
        for mutation in ("review", "field", "enum", "id"):
            with self.subTest(mutation=mutation):
                bad = copy.deepcopy(self.snapshot)
                if mutation == "review":
                    bad["links"][0]["review"] = None
                elif mutation == "field":
                    bad["memories"][0]["confidence"] = 0.99
                elif mutation == "enum":
                    bad["links"][0]["type"] = "causes"
                else:
                    bad["memories"][0]["id"] = bad["inputs"][0]["id"]
                with self.assertRaises(Invalid):
                    validate(bad)

    def test_stale_token_rejected_without_transition(self):
        self.review(H)
        bad = copy.deepcopy(self.snapshot)
        bad["inputs"][0]["state"] = "withdrawn"
        with self.assertRaises(Invalid):
            validate(bad)

    def test_duplicate_record_update_rejected(self):
        record = memory("new", "새 기억")
        with self.assertRaises(Invalid):
            self.transact([put("memories", record), put("memories", record)])

    def test_invalid_change_schema_and_boolean_revision(self):
        for mutation in ("unknown", "operation", "revision", "date"):
            request = change("bad", self.snapshot["revision"], [put("memories", memory("new", "새 기억"))])
            if mutation == "unknown":
                request["automatic_truth"] = True
            elif mutation == "operation":
                request["operations"][0]["op"] = "delete_everything"
            elif mutation == "revision":
                request["expected_revision"] = True
            else:
                request["recorded_at"] = "어제"
            with self.subTest(mutation=mutation), self.assertRaises(Invalid):
                apply(self.snapshot, request, self.receipts)

    def test_failed_final_validation_preserves_original(self):
        before, saved = digest(self.snapshot), copy.deepcopy(self.receipts)
        original = self.snapshot["inputs"][0]
        relation = link("missing-target", original["id"], "missing", "supports", original)
        with self.assertRaises(Invalid):
            self.transact([put("memories", memory("new", "새 기억")), put("links", relation)])
        self.assertEqual(digest(self.snapshot), before)
        self.assertEqual(self.receipts, saved)

    def test_invalid_context_window(self):
        bad = copy.deepcopy(self.snapshot)
        bad["memories"][0]["context"].update(valid_from="2026-02-01T00:00:00Z", valid_until="2026-01-01T00:00:00Z")
        with self.assertRaises(Invalid):
            validate(bad)

    def test_current_relation_needs_exact_basis(self):
        bad = copy.deepcopy(self.snapshot)
        bad["links"][1]["basis"] = []
        with self.assertRaises(Invalid):
            validate(bad)

    def test_token_vectors(self):
        import json
        from pathlib import Path
        vectors = json.loads((Path(__file__).resolve().parents[1] / "examples/token-vectors.json").read_text())
        for vector in vectors:
            with self.subTest(id=vector["memory_id"]):
                self.assertEqual(review_token(self.snapshot, vector["memory_id"]), vector["token"])


if __name__ == "__main__":
    unittest.main()
