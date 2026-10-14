import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { MemoryStore } from "./store.mjs";
import { prepareEvolution } from "./evolution.mjs";
const context = {
    scope: "test",
    condition: "ordinary work",
    valid_from: null,
    valid_until: null,
  },
  at = "2026-01-01T00:00:00Z";
const original = {
  id: "original",
  revision: 1,
  text: "The method worked in one condition.",
  sha256: createHash("sha256")
    .update("The method worked in one condition.")
    .digest("hex"),
  source: "urn:test:source",
  origin_group: "event-1",
  observed_at: at,
  recorded_at: at,
  state: "available",
};
const base = {
  actor: "reviewer",
  recorded_at: at,
  reason: "Read experience, condition and relation",
};
const memory = {
  id: "method",
  revision: 1,
  text: "The method is effective.",
  kind: "belief",
  context,
  state: "current",
  review_required: true,
  review: null,
};
const basis = {
  input_id: original.id,
  sha256: original.sha256,
  start: 0,
  end: original.text.length,
  quote: original.text,
};
const relation = {
  id: "support",
  revision: 1,
  source: original.id,
  target: memory.id,
  type: "supports",
  context,
  state: "current",
  basis: [basis],
  review: { actor: "reviewer", reason: "Same observation and condition" },
};
function setup() {
  const s = new MemoryStore(new DatabaseSync(":memory:"), { owned: true });
  s.install();
  s.apply(
    prepareEvolution(s, {
      ...base,
      request_id: "init",
      sources: [original],
      memories: [memory],
      links: [relation],
    }),
  );
  return s;
}
test("meaning and condition evolve without rewriting original", () => {
  const s = setup();
  try {
    const plan = prepareEvolution(s, {
      ...base,
      request_id: "refine",
      memories: [
        {
          ...memory,
          text: "The method is effective only when the prerequisite is met.",
          context: { ...context, condition: "prerequisite met" },
        },
      ],
    });
    s.apply(plan);
    assert.equal(s.raw("method").revision, 2);
    assert.equal(s.source("original").text, original.text);
    assert.equal(s.evidence("method").support_groups.length, 0);
    assert.equal(s.history("method")[0].id, "refine");
    assert.equal(s.inspect("method").fresh, false);
  } finally {
    s.close();
  }
});
test("unit changes are guarded independently of unrelated memories", () => {
  const s = setup();
  try {
    const units = [
      {
        input_id: "original",
        key: "body",
        start: 0,
        end: original.text.length,
        outcome: "integrated",
        targets: ["method"],
        reason: "This experience informs the method memory",
      },
    ];
    const first = prepareEvolution(s, { ...base, request_id: "unit", units });
    s.apply(first);
    const stale = prepareEvolution(s, {
      ...base,
      request_id: "stale",
      units: units.map((u) => ({
        ...u,
        outcome: "unknown",
        reason: "Ambiguous",
      })),
    });
    s.apply(
      prepareEvolution(s, {
        ...base,
        request_id: "next",
        units: units.map((u) => ({
          ...u,
          outcome: "evidence-only",
          targets: [],
          reason: "No new independent evidence",
        })),
      }),
    );
    assert.throws(() => s.apply(stale), /unit change/);
  } finally {
    s.close();
  }
});
test("external source precondition checked within transaction", () => {
  const s = setup();
  try {
    s.validateChange = () => {
      throw new Error("External version changed");
    };
    const p = prepareEvolution(s, {
      ...base,
      request_id: "change",
      memories: [{ ...memory, text: "Refined" }],
    });
    assert.throws(() => s.apply(p), /External/);
    assert.equal(s.raw("method").revision, 1);
    assert.equal(s.receipt("change"), null);
  } finally {
    s.close();
  }
});
test("recall activation is query relevance, not confidence", () => {
  const s = setup();
  try {
    const result = s.recall("method");
    assert.equal(result.records.length, 1);
    assert.equal(result.activation_semantics, "query_relevance_not_truth");
    assert.equal(s.evidence("method").support_groups.length, 1);
  } finally {
    s.close();
  }
});
test("invalid calendar date and malformed Unicode rejected", () => {
  const s = setup();
  try {
    for (const patch of [
      { recorded_at: "2026-02-31T00:00:00Z" },
      { text: "broken\ud800" },
    ])
      assert.throws(() =>
        s.apply(
          prepareEvolution(s, {
            ...base,
            request_id: "bad",
            sources: [{ ...original, id: "bad", ...patch }],
          }),
        ),
      );
  } finally {
    s.close();
  }
});
test("adapter metadata failure rolls back core records and request receipt", () => {
  const s = setup();
  try {
    s.db.exec("CREATE TABLE adapter(value TEXT)");
    s.afterChange = () => {
      s.db.exec("INSERT INTO adapter VALUES('partial')");
      throw new Error("Adapter failure");
    };
    const plan = prepareEvolution(s, {
      ...base,
      request_id: "adapter-failure",
      memories: [{ ...memory, text: "Changed" }],
    });
    assert.throws(() => s.apply(plan), /Adapter failure/);
    assert.equal(s.raw("method").revision, 1);
    assert.equal(s.receipt("adapter-failure"), null);
    assert.equal(s.db.prepare("SELECT count(*) n FROM adapter").get().n, 0);
  } finally {
    s.close();
  }
});
test("large source is verified once per atomic unit batch", () => {
  const s = setup();
  try {
    const text = "Paragraph with condition and exception.\n\n".repeat(10000),
      input = {
        ...original,
        id: "large",
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
      };
    s.apply(
      prepareEvolution(s, {
        ...base,
        request_id: "large-source",
        sources: [input],
      }),
    );
    let reads = 0;
    const source = s.source.bind(s);
    s.source = (id) => {
      reads++;
      return source(id);
    };
    const width = "Paragraph with condition and exception.\n\n".length;
    const units = Array.from({ length: 1000 }, (_, i) => ({
      input_id: "large",
      key: "p" + i,
      start: i * width,
      end: (i + 1) * width,
      outcome: "unknown",
      targets: [],
      reason: "Await semantic review",
    }));
    s.apply(prepareEvolution(s, { ...base, request_id: "large-units", units }));
    assert.equal(reads, 1);
    assert.equal(s.stats().units.find((u) => u.outcome === "unknown").n, 1000);
  } finally {
    s.close();
  }
});
