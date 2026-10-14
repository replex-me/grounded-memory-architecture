import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, digest } from "./store.mjs";

const at = "2026-01-01T00:00:00Z",
  ctx = {
    scope: "test",
    condition: "same condition",
    valid_from: null,
    valid_until: null,
  };
const source = (id = "s", group = "event") => {
  const text = "A real observation 😀";
  return {
    id,
    revision: 1,
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    source: "urn:test:source",
    origin_group: group,
    observed_at: at,
    recorded_at: at,
    state: "available",
  };
};
const memory = (id = "a") => ({
  id,
  revision: 1,
  text: "A useful memory",
  kind: "belief",
  context: ctx,
  state: "current",
  review_required: true,
  review: null,
});
const link = (id, from, to, type = "supports", s = source()) => ({
  id,
  revision: 1,
  source: from,
  target: to,
  type,
  context: ctx,
  state: "current",
  basis: [
    {
      input_id: s.id,
      sha256: s.sha256,
      start: 0,
      end: Array.from(s.text).length,
      quote: s.text,
    },
  ],
  review: { actor: "tester", reason: "Verified source and meaning" },
});
const put = (type, record) => ({ op: "put", type, record });
function setup(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;");
  const store = new MemoryStore(db, { owned: true });
  store.install();
  const s = source(),
    a = memory(),
    b = memory("b");
  const ops = [
    put("input", s),
    put("memory", a),
    put("memory", b),
    put("link", link("e", "s", "a")),
    put("link", link("d", "b", "a", "requires")),
  ];
  store.apply({
    request_id: "start",
    actor: "tester",
    reason: "Initial meaning",
    recorded_at: at,
    expect: store.guard(["s", "a", "b", "e", "d"]),
    operations: ops,
  });
  return store;
}
function apply(s, ops, ids, id = "r" + s.stats().changes) {
  return s.apply({
    request_id: id,
    actor: "tester",
    reason: "Meaning and evidence review",
    recorded_at: at,
    expect: s.guard(ids),
    expect_units: Object.fromEntries(
      ops
        .filter((o) => o.op === "unit")
        .map((o) => [
          JSON.stringify([o.input_id, o.key]),
          s.unitGuard(o.input_id, o.key),
        ]),
    ),
    operations: ops,
  });
}
function review(s, ids) {
  return apply(
    s,
    ids.map((id) => ({
      op: "review",
      id,
      token: s.proof(id).token,
      reason: "Read original evidence and all premises",
    })),
    ids,
  );
}

test("persistent records, source, links and local recall", () => {
  const s = setup();
  try {
    assert.equal(s.inspect("a").evidence.support_groups.length, 1);
    assert.equal(s.source("s").text, source().text);
    assert.equal(s.recall("useful").records.length, 2);
    assert.equal(s.list({ scope: "else" }).total, 0);
  } finally {
    s.close();
  }
});
test("concurrent connection stale read set rejected, unrelated write allowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-"));
  const file = path.join(dir, "data.sqlite"),
    a = setup(file),
    b = new MemoryStore(file);
  try {
    const expect = a.guard(["a"]),
      old = a.raw("a");
    apply(
      b,
      [put("memory", { ...old, text: "Changed meaning", revision: 2 })],
      ["a"],
    );
    assert.throws(
      () =>
        a.apply({
          request_id: "conflict",
          actor: "x",
          reason: "x",
          recorded_at: at,
          expect,
          operations: [put("memory", { ...old, revision: 2 })],
        }),
      /Concurrent/,
    );
    const guard = a.guard(["a"]);
    apply(b, [put("memory", memory("other"))], ["other"]);
    assert.deepEqual(a.guard(["a"]), guard);
  } finally {
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true });
  }
});
test("immutable original, dangling endpoints and transaction rollback", () => {
  const s = setup();
  try {
    assert.throws(() =>
      apply(
        s,
        [
          put("memory", memory("new")),
          put("link", link("bad", "s", "missing")),
        ],
        ["new", "bad", "s", "missing"],
      ),
    );
    assert.equal(s.raw("new"), null);
    assert.equal(s.receipt("r1"), null);
    assert.throws(
      () => apply(s, [put("input", { ...source(), revision: 2 })], ["s"]),
      /Immutable/,
    );
  } finally {
    s.close();
  }
});
test("request replay survives restart and different payload rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-"));
  const file = path.join(dir, "data.sqlite");
  let s = setup(file);
  try {
    const change = {
      request_id: "retry",
      actor: "tester",
      reason: "New memory",
      recorded_at: at,
      expect: s.guard(["new"]),
      operations: [put("memory", memory("new"))],
    };
    const result = s.apply(change);
    s.close();
    s = new MemoryStore(file);
    assert.deepEqual(s.apply(change), result);
    assert.throws(() => s.apply({ ...change, reason: "Different" }), /reused/);
    assert.equal(s.receipt("retry").request_id, "retry");
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true });
  }
});
test("new opposition and source withdrawal propagate to dependent memories", () => {
  const s = setup();
  try {
    review(s, ["a"]);
    review(s, ["b"]);
    const raw = source("f", "failure");
    apply(
      s,
      [
        put("input", raw),
        put("link", link("f-link", "f", "a", "opposes", raw)),
      ],
      ["f", "f-link", "a"],
    );
    assert.equal(s.inspect("a").evidence.opposition_groups.length, 1);
    assert.equal(s.inspect("b").fresh, false);
    apply(s, [{ op: "withdraw_input", id: "f" }], ["f"]);
    assert.equal(s.evidence("a").opposition_groups.length, 0);
  } finally {
    s.close();
  }
});
test("duplicate evidence and conflict groups are not stronger belief", () => {
  const s = setup();
  try {
    const raw = source("copy");
    apply(
      s,
      [
        put("input", raw),
        put("link", link("copy-link", "copy", "a", "supports", raw)),
      ],
      ["copy", "copy-link", "a"],
    );
    assert.equal(s.evidence("a").support_groups.length, 1);
    apply(
      s,
      [put("link", link("opp", "s", "a", "opposes"))],
      ["opp", "s", "a"],
    );
    assert.equal(s.evidence("a").support_groups.length, 0);
    assert.equal(s.evidence("a").conflict_groups.length, 1);
  } finally {
    s.close();
  }
});
test("semantic link withdrawal changes token and related links do not", () => {
  const s = setup();
  try {
    review(s, ["a"]);
    review(s, ["b"]);
    const proof = s.proof("b").token;
    apply(
      s,
      [put("link", link("rel", "a", "b", "related"))],
      ["rel", "a", "b", "s"],
    );
    assert.equal(s.proof("b").token, proof);
    assert.equal(s.inspect("b").fresh, true);
    const old = s.raw("d");
    apply(
      s,
      [put("link", { ...old, revision: 2, state: "withdrawn" })],
      ["d", "a", "b", "s"],
    );
    assert.notEqual(s.proof("b").token, proof);
  } finally {
    s.close();
  }
});
test("cycle terminates and group review works", () => {
  const s = setup();
  try {
    apply(
      s,
      [put("link", link("cycle", "a", "b", "requires"))],
      ["cycle", "a", "b", "s"],
    );
    assert.throws(() => review(s, ["a"]), /Unreviewed/);
    review(s, ["a", "b"]);
    assert.equal(s.inspect("a").fresh, true);
    assert.equal(s.inspect("b").fresh, true);
    apply(s, [{ op: "withdraw_input", id: "s" }], ["s"]);
    assert.equal(s.inspect("b").fresh, false);
  } finally {
    s.close();
  }
});
test("usage is deduplicated and is not evidence", () => {
  const s = setup();
  try {
    const before = s.evidence("a").support_groups;
    apply(s, [{ op: "use", task_id: "task", id: "a" }], []);
    apply(s, [{ op: "use", task_id: "task", id: "a" }], []);
    assert.equal(s.evidence("a").usage_count, 1);
    assert.deepEqual(s.evidence("a").support_groups, before);
  } finally {
    s.close();
  }
});
test("original to original links, invalid quotes, unknown fields rejected", () => {
  const s = setup();
  try {
    assert.throws(() =>
      apply(s, [put("link", link("bad", "s", "s"))], ["bad", "s"]),
    );
    const bad = link("bad", "s", "a");
    bad.basis[0].quote = "Invented";
    assert.throws(() => apply(s, [put("link", bad)], ["bad", "s", "a"]));
    assert.throws(() =>
      apply(
        s,
        [put("memory", { ...memory("new"), confidence: 0.99 })],
        ["new"],
      ),
    );
  } finally {
    s.close();
  }
});
test("units track all source outcomes and corruption is detected on source read", () => {
  const s = setup();
  try {
    apply(
      s,
      [
        {
          op: "unit",
          input_id: "s",
          key: "body",
          start: 0,
          end: Array.from(source().text).length,
          outcome: "integrated",
          targets: ["a"],
          reason: "Preserved meaning in memory",
        },
      ],
      ["s", "a"],
    );
    assert.equal(s.inspect("s").units.length, 1);
    const damaged = s.raw("s");
    damaged.text += "damaged";
    s.db
      .prepare("UPDATE memory_records SET data=? WHERE id=?")
      .run(JSON.stringify(damaged), "s");
    assert.throws(() => s.source("s"), /corruption/);
  } finally {
    s.close();
  }
});

test("search combines unordered terms across name, body and condition; short and long terms use the same state boundary", () => {
  const s = setup();
  try {
    const m = { ...memory('searchable'), text: 'Available river workflow',
      context: { ...ctx, condition: 'AA required' },
      extensions: { 'memory:title': 'Bridge archive' } };
    const retired = { ...m, id: 'retired', state: 'superseded' };
    apply(s, [put('memory', m), put('memory', retired)], ['searchable', 'retired']);
    const ids = query => s.list({ query }).records.map(r => r.id);
    assert.deepEqual(ids('river archive AA'), ['searchable']);
    assert.deepEqual(ids(' AA\tarchive  river '), ['searchable']);
    assert.deepEqual(ids('AA'), ['searchable']);
    assert.deepEqual(ids('archive'), ['searchable']);
    assert.deepEqual(ids('river absent'), []);
    assert.deepEqual(ids('river OR archive'), []);
    assert.deepEqual(ids('" OR "'), []);
    assert.equal(s.list().records.some(r => r.id === 'retired'), true);
    const before = s.proof('searchable').token;
    s.rebuildSearch();
    assert.deepEqual(ids('archive AA river'), ['searchable']);
    assert.equal(s.proof('searchable').token, before);
  } finally { s.close(); }
});

test("recall does not reactivate retired memories or traverse them as bridges", () => {
  const s = setup();
  try {
    const live = { ...memory('live'), text: 'Unique replacement procedure' };
    const retired = { ...memory('retired'), state: 'superseded' };
    const withdrawn = { ...memory('withdrawn'), state: 'withdrawn' };
    const behind = { ...memory('behind'), text: 'Unrelated historical neighbor' };
    apply(s, [put('memory', live), put('memory', retired), put('memory', withdrawn),
      put('memory', behind), put('link', link('revision', 'live', 'retired', 'revises')),
      put('link', link('old-neighbor', 'retired', 'behind', 'related')),
      put('link', link('withdrawn-edge', 'live', 'withdrawn', 'related'))],
      ['live', 'retired', 'withdrawn', 'behind', 'revision', 'old-neighbor', 'withdrawn-edge', 's']);
    const before = s.proof('live').token;
    const recalled = s.recall('Unique replacement', { hops: 3 });
    assert.deepEqual(recalled.records.map(r => r.id), ['live']);
    assert.equal(s.inspect('retired').state, 'superseded');
    assert.equal(s.inspect('withdrawn').state, 'withdrawn');
    assert.equal(s.links('retired').some(l => l.id === 'revision'), true);
    assert.equal(s.proof('live').token, before);
    review(s, ['a', 'b', 'live', 'behind']);
    assert.equal(s.stats().pending, 0);
    apply(s, [put('memory', { ...memory('proposal'), state: 'candidate' })], ['proposal']);
    assert.equal(s.stats().pending, 1);
  } finally { s.close(); }
});
