"""Synthetic, bidirectional Python/JavaScript snapshot-profile exchange."""
import copy
import json
import subprocess
import unittest
from pathlib import Path

from examples.build import change, initial, input_, link, put
from reference.model import Invalid, apply, encoded, review_token, validate

ROOT = Path(__file__).resolve().parents[1]
H = "urn:example:memory:diagnose"
P = "urn:example:memory:procedure"


class ExchangeTests(unittest.TestCase):
    def node(self, snapshot, valid=True):
        result = subprocess.run(
            ["node", "tools/snapshot-exchange.mjs"], cwd=ROOT,
            input=json.dumps(snapshot, ensure_ascii=True), text=True, capture_output=True,
        )
        if not valid:
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            return
        self.assertEqual(result.returncode, 0, result.stderr)
        exchange = json.loads(result.stdout)
        validate(exchange["snapshot"])
        self.assertEqual(exchange["snapshot"], snapshot)
        for memory in snapshot["memories"]:
            self.assertEqual(exchange["tokens"][memory["id"]], review_token(snapshot, memory["id"]))
        return exchange

    def test_exchange_before_review_after_review_and_after_counterexample(self):
        snapshot, receipts = initial()
        snapshot = self.node(snapshot)["snapshot"]
        operations = [{"op": "review", "id": id_, "token": review_token(snapshot, id_), "reason": "Synthetic review"} for id_ in (H, P)]
        snapshot, receipts, _ = apply(snapshot, change("review", snapshot["revision"], operations), receipts)
        snapshot = self.node(snapshot)["snapshot"]
        counterexample = input_("urn:example:input:failure", "Synthetic failure: missing state information.", "urn:example:event:failure")
        snapshot, _, _ = apply(snapshot, change("counterexample", snapshot["revision"], [
            put("inputs", counterexample),
            put("links", link("urn:example:link:failure", counterexample["id"], H, "opposes", counterexample)),
        ]), receipts)
        self.assertTrue(all(r["review_required"] for r in snapshot["memories"]))
        self.node(snapshot)

    def test_fixed_vectors_and_reordered_arrays(self):
        snapshot, _ = initial()
        vectors = json.loads((ROOT / "examples/token-vectors.json").read_text())
        result = self.node(snapshot)
        self.assertEqual(result["tokens"], {v["memory_id"]: v["token"] for v in vectors})
        snapshot["memories"].reverse()
        snapshot["links"].reverse()
        self.assertEqual(self.node(snapshot)["tokens"], result["tokens"])

    def test_unicode_positions_and_canonical_object_key_order(self):
        snapshot, _ = initial()
        original = input_("urn:example:input:unicode", "😀e\u0301한\n", "unicode-event")
        original["extensions"] = {"test:values": {"10": "ten", "2": "two", "\ue000": "BMP", "😀": "astral", "zero": 0}}
        relation = link("urn:example:link:unicode", original["id"], H, "context", original)
        relation["basis"][0].update(start=1, end=4, quote="e\u0301한")
        snapshot["inputs"].append(original)
        snapshot["links"].append(relation)
        self.node(snapshot)

    def test_reject_corruption_boundaries_stale_review_and_unknown_fields(self):
        snapshot, receipts = initial()
        snapshot, _, _ = apply(snapshot, change("review", snapshot["revision"], [
            {"op": "review", "id": id_, "token": review_token(snapshot, id_), "reason": "Synthetic review"} for id_ in (H, P)
        ]), receipts)
        mutations = [
            lambda s: s["inputs"][0].update(text="tampered"),
            lambda s: s["links"][0]["basis"][0].update(quote="wrong"),
            lambda s: s["links"][0]["basis"][0].update(end=10000),
            lambda s: s["links"][0].update(target=s["inputs"][0]["id"]),
            lambda s: s["memories"][0].update(text="changed without review"),
            lambda s: s["memories"][0].update(unrecognized=True),
            lambda s: s["memories"].append(copy.deepcopy(s["memories"][0])),
            lambda s: s.update(format="memory-store/1"),
            lambda s: s["links"][0].update(review=None),
        ]
        for i, mutate in enumerate(mutations):
            with self.subTest(case=i):
                bad = copy.deepcopy(snapshot)
                mutate(bad)
                with self.assertRaises(Invalid):
                    validate(bad)
                self.node(bad, valid=False)

    def test_reject_unportable_extension_numbers_and_surrogates(self):
        for value in (1.5, 9007199254740992, "\ud800"):
            with self.subTest(value=repr(value)):
                snapshot, _ = initial()
                snapshot["extensions"] = {"test:value": value}
                with self.assertRaises((Invalid, UnicodeError)):
                    validate(snapshot)
                self.node(snapshot, valid=False)
        self.assertEqual(encoded({"test:value": -0.0}), '{"test:value":0}')

    def test_integral_json_numbers_have_one_encoding(self):
        snapshot, _ = initial()
        snapshot["extensions"] = {"test:numbers": [1.0, -0.0, 9007199254740991]}
        self.node(snapshot)

    def test_invalid_calendar_and_clock_values_are_rejected(self):
        for timestamp in ("2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00-00:00"):
            with self.subTest(timestamp=timestamp):
                snapshot, _ = initial()
                snapshot["inputs"][0]["recorded_at"] = timestamp
                with self.assertRaises(Invalid):
                    validate(snapshot)
                self.node(snapshot, valid=False)

    def test_cycles_and_noncurrent_relations_keep_matching_tokens(self):
        snapshot, receipts = initial()
        original = snapshot["inputs"][0]
        reverse = link("urn:example:link:reverse", H, P, "requires", original)
        snapshot, receipts, _ = apply(snapshot, change("cycle", snapshot["revision"], [put("links", reverse)]), receipts)
        self.node(snapshot)
        snapshot, _, _ = apply(snapshot, change("cycle-review", snapshot["revision"], [
            {"op": "review", "id": id_, "token": review_token(snapshot, id_), "reason": "Synthetic cycle review"} for id_ in (H, P)
        ]), receipts)
        self.node(snapshot)
        for state in ("candidate", "withdrawn"):
            altered = copy.deepcopy(snapshot)
            for m in altered["memories"]:
                m.update(review_required=True, review=None)
            altered["links"][0]["state"] = state
            self.node(altered)
        related = copy.deepcopy(snapshot)
        relation = link("urn:example:link:navigation", H, P, "related", original)
        related["links"].append(relation)
        self.assertEqual(self.node(related)["tokens"], self.node(snapshot)["tokens"])

    def test_prototype_named_unknown_fields_are_rejected(self):
        for key in ("constructor", "toString", "__proto__"):
            for location in ("snapshot", "memory", "context", "selector"):
                with self.subTest(key=key, location=location):
                    snapshot, _ = initial()
                    target = {
                        "snapshot": snapshot,
                        "memory": snapshot["memories"][0],
                        "context": snapshot["memories"][0]["context"],
                        "selector": snapshot["links"][0]["basis"][0],
                    }[location]
                    target[key] = 0
                    with self.assertRaises(Invalid):
                        validate(snapshot)
                    self.node(snapshot, valid=False)
