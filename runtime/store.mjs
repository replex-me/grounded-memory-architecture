// SPDX-License-Identifier: Apache-2.0
// SQLite-backed memory management. No model calls, credentials or source extraction.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const kinds = new Set([
  "observation",
  "belief",
  "principle",
  "goal",
  "procedure",
  "question",
]);
const relations = new Set([
  "context",
  "supports",
  "opposes",
  "requires",
  "related",
  "revises",
]);
const states = new Set(["candidate", "current", "superseded", "withdrawn"]);
const cpCompare = (a, b) => {
  const x = Array.from(a, (c) => c.codePointAt(0)),
    y = Array.from(b, (c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};
export const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && !Array.isArray(v) && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort(cpCompare)
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export const digest = (value) => hash(canonical(value));
const assert = (v, m) => {
  if (!v) throw new Error(m);
};
const text = (v, name) =>
  assert(
    typeof v === "string" && v.trim() && v.isWellFormed(),
    name + " must be nonempty",
  );
const version = (v) =>
  assert(Number.isSafeInteger(v) && v >= 1, "Invalid revision");
const date = (v) => {
  assert(
    typeof v === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
        v,
      ) &&
      !v.endsWith("-00:00") &&
      Number.isFinite(Date.parse(v)),
    "Invalid timestamp",
  );
  const [year, month, day] = v.slice(0, 10).split("-").map(Number),
    d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  assert(
    year > 0 &&
      d.getUTCFullYear() === year &&
      d.getUTCMonth() === month - 1 &&
      d.getUTCDate() === day,
    "Invalid calendar date",
  );
};
const context = (v) => {
  assert(v && typeof v === "object" && !Array.isArray(v), "Context required");
  text(v.scope, "scope");
  assert(typeof v.condition === "string", "Condition required");
  for (const k of ["valid_from", "valid_until"]) if (v[k] !== null) date(v[k]);
  if (v.valid_from && v.valid_until)
    assert(
      Date.parse(v.valid_from) < Date.parse(v.valid_until),
      "Invalid validity interval",
    );
};
const semanticDependent = (l) => (l.type === "requires" ? l.source : l.target);
const json = (r) => (r ? JSON.parse(r.data) : null);
const schema = JSON.parse(
  fs.readFileSync(
    new URL("../schema/model.schema.json", import.meta.url),
    "utf8",
  ),
);
const runtimeSchema = JSON.parse(
  fs.readFileSync(
    new URL("../schema/runtime-change.schema.json", import.meta.url),
    "utf8",
  ),
);
function shape(rule, value) {
  if (Object.hasOwn(rule, "const"))
    assert(value === rule.const, "Unknown constant");
  if (rule.oneOf) {
    const matches = rule.oneOf.filter((r) => {
      try {
        shape(r, value);
        return true;
      } catch {
        return false;
      }
    });
    assert(matches.length === 1, "Expected one schema shape");
    return;
  }
  if (rule.$ref) return shape(schema.$defs[rule.$ref.split("/").pop()], value);
  if (rule.anyOf) {
    assert(
      rule.anyOf.some((r) => {
        try {
          shape(r, value);
          return true;
        } catch {
          return false;
        }
      }),
      "No matching schema shape",
    );
    return;
  }
  if (rule.enum) assert(rule.enum.includes(value), "Unknown enum value");
  if (rule.type) {
    const ok = {
      null: value === null,
      string: typeof value === "string",
      integer: Number.isSafeInteger(value),
      boolean: typeof value === "boolean",
      array: Array.isArray(value),
      object:
        value !== null && typeof value === "object" && !Array.isArray(value),
    };
    assert(ok[rule.type], "Invalid schema type");
  }
  if (typeof value === "string") {
    assert(value.isWellFormed(), "Malformed Unicode");
    if (rule.minLength)
      assert(Array.from(value).length >= rule.minLength, "Short string");
    if (rule.pattern)
      assert(new RegExp(rule.pattern).test(value), "Invalid pattern");
    if (rule.format === "date-time") date(value);
  }
  if (typeof value === "number") {
    if (rule.minimum !== undefined)
      assert(value >= rule.minimum, "Below minimum");
    if (rule.maximum !== undefined)
      assert(value <= rule.maximum, "Above maximum");
  }
  if (Array.isArray(value)) {
    if (rule.minItems)
      assert(value.length >= rule.minItems, "Empty operations");
    if (rule.items) for (const item of value) shape(rule.items, item);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of rule.required || [])
      assert(Object.hasOwn(value, key), "Missing property: " + key);
    for (const [key, v] of Object.entries(value)) {
      if (rule.properties?.[key]) shape(rule.properties[key], v);
      else if (rule.additionalProperties === false)
        throw new Error("Unknown property: " + key);
      else if (
        rule.additionalProperties &&
        typeof rule.additionalProperties === "object"
      )
        shape(rule.additionalProperties, v);
      if (rule.propertyNames) shape(rule.propertyNames, key);
    }
  }
}

export class MemoryStore {
  constructor(
    database,
    { owned = false, validateChange = null, afterChange = null } = {},
  ) {
    this.db =
      typeof database === "string" ? new DatabaseSync(database) : database;
    this.owned = owned || typeof database === "string";
    this.validateChange = validateChange;
    this.afterChange = afterChange;
    this.db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;");
  }
  close() {
    if (this.owned) this.db.close();
  }
  installed() {
    return Boolean(
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_records'",
        )
        .get(),
    );
  }
  install() {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO memory_meta VALUES('version','1');
      CREATE TABLE IF NOT EXISTS memory_records(id TEXT PRIMARY KEY,type TEXT NOT NULL CHECK(type IN ('input','memory','link')),revision INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),proof TEXT NOT NULL CHECK(json_valid(proof)),text TEXT NOT NULL,scope TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_scope ON memory_records(type,scope,id);
      CREATE TABLE IF NOT EXISTS memory_edges(id TEXT PRIMARY KEY REFERENCES memory_records(id),source TEXT NOT NULL REFERENCES memory_records(id) DEFERRABLE INITIALLY DEFERRED,target TEXT NOT NULL REFERENCES memory_records(id) DEFERRABLE INITIALLY DEFERRED,type TEXT NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_incoming ON memory_edges(target,type,state);
      CREATE INDEX IF NOT EXISTS memory_outgoing ON memory_edges(source,type,state);
      CREATE TABLE IF NOT EXISTS memory_basis(link_id TEXT NOT NULL REFERENCES memory_records(id),input_id TEXT NOT NULL REFERENCES memory_records(id),PRIMARY KEY(link_id,input_id));
      CREATE INDEX IF NOT EXISTS memory_basis_input ON memory_basis(input_id);
      CREATE TABLE IF NOT EXISTS memory_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,request TEXT NOT NULL CHECK(json_valid(request)),result TEXT NOT NULL CHECK(json_valid(result)));
      CREATE TABLE IF NOT EXISTS memory_units(input_id TEXT NOT NULL REFERENCES memory_records(id),key TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,outcome TEXT NOT NULL,targets TEXT NOT NULL CHECK(json_valid(targets)),reason TEXT NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(input_id,key));
      CREATE TABLE IF NOT EXISTS memory_usage(task_id TEXT NOT NULL,memory_id TEXT NOT NULL REFERENCES memory_records(id),at TEXT NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(task_id,memory_id));
      CREATE TABLE IF NOT EXISTS memory_change_members(request_id TEXT NOT NULL REFERENCES memory_requests(id),record_id TEXT NOT NULL REFERENCES memory_records(id),PRIMARY KEY(request_id,record_id));
      CREATE INDEX IF NOT EXISTS memory_change_record ON memory_change_members(record_id,request_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED,text,scope UNINDEXED,tokenize='trigram');`);
    assert(
      this.db.prepare("SELECT value FROM memory_meta WHERE key='version'").get()
        ?.value === "1",
      "Unsupported memory schema",
    );
  }
  transaction(fn, write = false) {
    const nested = this.db.isTransaction,
      savepoint = "memory_" + randomUUID().replaceAll("-", "");
    this.db.exec(
      nested ? "SAVEPOINT " + savepoint : write ? "BEGIN IMMEDIATE" : "BEGIN",
    );
    try {
      const r = fn();
      assert(!r?.then, "Transaction callback must be synchronous");
      this.db.exec(nested ? "RELEASE " + savepoint : "COMMIT");
      return r;
    } catch (e) {
      try {
        if (nested) {
          this.db.exec("ROLLBACK TO " + savepoint);
          this.db.exec("RELEASE " + savepoint);
        } else this.db.exec("ROLLBACK");
      } catch (rollback) {
        if (e && typeof e === "object") e.rollbackError = rollback.message;
      }
      throw e;
    }
  }
  record(id) {
    const r = this.db
      .prepare("SELECT type,data FROM memory_records WHERE id=?")
      .get(id);
    return r ? { record_type: r.type, ...JSON.parse(r.data) } : null;
  }
  raw(id) {
    return json(
      this.db.prepare("SELECT data FROM memory_records WHERE id=?").get(id),
    );
  }
  head(id) {
    const r = this.db
      .prepare("SELECT type,proof FROM memory_records WHERE id=?")
      .get(id);
    return r ? { record_type: r.type, ...JSON.parse(r.proof) } : null;
  }
  source(id) {
    const r = this.record(id);
    assert(r?.record_type === "input", "Unknown source");
    assert(hash(r.text) === r.sha256, "Source corruption");
    return r;
  }
  put(type, r) {
    const proof = { ...r };
    if (type === "input") delete proof.text;
    this.db
      .prepare(
        "INSERT INTO memory_records VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,proof=excluded.proof,text=excluded.text,scope=excluded.scope",
      )
      .run(
        r.id,
        type,
        r.revision,
        canonical(r),
        canonical(proof),
        r.text || "",
        r.context?.scope || r.extensions?.["memory:scope"] || "",
      );
    if (type === "memory") {
      this.db.prepare("DELETE FROM memory_search WHERE id=?").run(r.id);
      if (!["withdrawn", "superseded"].includes(r.state))
        this.db
          .prepare("INSERT INTO memory_search VALUES(?,?,?)")
          .run(r.id, r.text, r.context.scope);
    }
    if (type === "link") {
      this.db
        .prepare(
          "INSERT INTO memory_edges VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,target=excluded.target,type=excluded.type,state=excluded.state",
        )
        .run(r.id, r.source, r.target, r.type, r.state);
      this.db.prepare("DELETE FROM memory_basis WHERE link_id=?").run(r.id);
      for (const id of new Set(r.basis.map((b) => b.input_id)))
        this.db.prepare("INSERT INTO memory_basis VALUES(?,?)").run(r.id, id);
    }
  }
  links(id, { related = true } = {}) {
    return this.db
      .prepare(
        `SELECT r.data FROM memory_edges e JOIN memory_records r ON r.id=e.id WHERE (e.source=? OR e.target=?) ${related ? "" : "AND e.type!='related'"} ORDER BY e.id`,
      )
      .all(id, id)
      .map(json);
  }
  dependencyLinks(id) {
    return this.db
      .prepare(
        "SELECT r.data FROM memory_edges e JOIN memory_records r ON r.id=e.id WHERE e.type!='related' AND ((e.type='requires' AND e.source=?) OR (e.type!='requires' AND e.target=?)) ORDER BY e.id",
      )
      .all(id, id)
      .map(json);
  }
  proof(id) {
    assert(this.head(id)?.record_type === "memory", "Unknown memory");
    const seen = new Set(),
      pending = [id],
      records = new Map(),
      links = new Map();
    while (pending.length) {
      const key = pending.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      const r = this.head(key);
      assert(r, "Missing dependency");
      const n = { ...r };
      delete n.record_type;
      delete n.review;
      if (key === id) delete n.review_required;
      records.set(key, n);
      if (r.record_type !== "memory") continue;
      for (const l of this.dependencyLinks(key)) {
        links.set(l.id, l);
        for (const b of l.basis) {
          const s = this.head(b.input_id);
          assert(s?.record_type === "input", "Missing basis");
          const v = { ...s };
          delete v.record_type;
          records.set(s.id, v);
        }
        if (l.state === "current")
          pending.push(l.type === "requires" ? l.target : l.source);
      }
    }
    const payload = {
      profile: "memory-store/1",
      nodes: [...records.values()].sort((a, b) => cpCompare(a.id, b.id)),
      links: [...links.values()].sort((a, b) => cpCompare(a.id, b.id)),
    };
    return {
      token: digest(payload),
      nodes: payload.nodes,
      links: payload.links,
    };
  }
  guard(ids) {
    return Object.fromEntries(
      [...new Set(ids)].map((id) => {
        const r = this.head(id);
        return [
          id,
          r?.record_type === "memory"
            ? this.proof(id).token
            : r
              ? digest(r)
              : null,
        ];
      }),
    );
  }
  unitGuard(input, key) {
    const r = this.db
      .prepare("SELECT * FROM memory_units WHERE input_id=? AND key=?")
      .get(input, key);
    return r ? digest(r) : null;
  }
  invalidate(start) {
    const seen = new Set(),
      pending = [...start];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const r = this.raw(id);
      if (r && kinds.has(r.kind)) {
        r.review_required = true;
        this.put("memory", r);
      }
      const adjacent = this.links(id, { related: false }).filter(
        (l) => l.state === "current",
      );
      for (const l of adjacent) {
        if (l.type === "requires" && l.target === id) pending.push(l.source);
        else if (l.type !== "requires" && l.source === id)
          pending.push(l.target);
      }
      for (const x of this.db
        .prepare(
          "SELECT r.data FROM memory_basis b JOIN memory_records r ON r.id=b.link_id JOIN memory_edges e ON e.id=b.link_id WHERE b.input_id=? AND e.state='current' AND e.type!='related'",
        )
        .all(id))
        pending.push(semanticDependent(json(x)));
    }
    return [...seen]
      .filter((id) => this.head(id)?.record_type === "memory")
      .sort(cpCompare);
  }
  validateRecord(
    type,
    r,
    readSource = (id) => {
      const source = this.source(id);
      return { source, chars: Array.from(source.text) };
    },
  ) {
    shape(schema.$defs[type], r);
    text(r.id, "id");
    version(r.revision);
    if (type === "input") {
      text(r.text, "text");
      text(r.source, "source");
      assert(hash(r.text) === r.sha256, "Source hash mismatch");
      if (r.observed_at !== null) date(r.observed_at);
      date(r.recorded_at);
      assert(["available", "withdrawn"].includes(r.state), "Source state");
      assert(
        r.origin_group === null ||
          (typeof r.origin_group === "string" && r.origin_group.trim()),
        "Origin group",
      );
      return;
    }
    if (type === "memory") {
      text(r.text, "text");
      assert(kinds.has(r.kind) && states.has(r.state), "Memory kind or state");
      context(r.context);
      assert(typeof r.review_required === "boolean", "Review state");
      return;
    }
    assert(
      type === "link" &&
        relations.has(r.type) &&
        ["candidate", "current", "withdrawn"].includes(r.state),
      "Link type or state",
    );
    context(r.context);
    assert(Array.isArray(r.basis), "Basis required");
    const a = this.head(r.source),
      b = this.head(r.target);
    assert(a && b?.record_type === "memory", "Link endpoints");
    if (a.record_type === "input")
      assert(
        ["context", "supports", "opposes"].includes(r.type) &&
          r.basis.length &&
          r.basis.every((x) => x.input_id === a.id),
        "Source link boundary",
      );
    else
      assert(
        a.record_type === "memory" && a.id !== b.id && r.type !== "context",
        "Memory link boundary",
      );
    if (r.state === "current") {
      text(r.review?.actor, "link reviewer");
      text(r.review?.reason, "link review reason");
      if (a.record_type === "memory" && r.type !== "related")
        assert(r.basis.length, "Semantic relation needs basis");
    }
    for (const q of r.basis) {
      const { source: s, chars } = readSource(q.input_id);
      assert(
        s.sha256 === q.sha256 &&
          Number.isSafeInteger(q.start) &&
          Number.isSafeInteger(q.end) &&
          q.start >= 0 &&
          q.start < q.end &&
          q.end <= chars.length &&
          chars.slice(q.start, q.end).join("") === q.quote,
        "Basis quote mismatch",
      );
    }
  }
  apply(change) {
    shape(runtimeSchema, change);
    text(change.request_id, "request_id");
    text(change.actor, "actor");
    text(change.reason, "reason");
    date(change.recorded_at);
    assert(
      change.expect &&
        typeof change.expect === "object" &&
        Array.isArray(change.operations) &&
        change.operations.length,
      "Change contract",
    );
    const h = digest(change);
    return this.transaction(() => {
      const prior = this.db
        .prepare("SELECT hash,result FROM memory_requests WHERE id=?")
        .get(change.request_id);
      if (prior) {
        assert(prior.hash === h, "Request id reused for different content");
        return JSON.parse(prior.result);
      }
      if (this.validateChange) this.validateChange(change, this);
      for (const [id, want] of Object.entries(change.expect))
        assert(this.guard([id])[id] === want, "Concurrent change: " + id);
      for (const [key, want] of Object.entries(change.expect_units || {})) {
        const [input, unit] = JSON.parse(key);
        assert(this.unitGuard(input, unit) === want, "Concurrent unit change");
      }
      const sourceCache = new Map();
      const readSource = (id) => {
        if (!sourceCache.has(id)) {
          const source = this.source(id);
          sourceCache.set(id, { source, chars: Array.from(source.text) });
        }
        return sourceCache.get(id);
      };
      const changed = new Set(),
        touched = new Set(),
        reviews = [],
        links = [];
      for (const op of change.operations) {
        if (op.op === "put") {
          const type = op.type,
            r = structuredClone(op.record),
            old = this.head(r.id);
          assert(
            ["input", "memory", "link"].includes(type),
            "Unknown record type",
          );
          assert(
            Object.hasOwn(change.expect, r.id),
            "Expected version required: " + r.id,
          );
          assert(!touched.has(r.id), "Duplicate mutation");
          touched.add(r.id);
          assert(!old || old.record_type === type, "Record type change");
          assert(
            r.revision === (old ? old.revision + 1 : 1),
            "Revision conflict",
          );
          if (type === "input") assert(!old, "Immutable source");
          if (type === "memory") {
            r.review_required = true;
            r.review = null;
            this.validateRecord(type, r);
            this.put(type, r);
            changed.add(r.id);
          } else if (type === "input") {
            this.validateRecord(type, r);
            this.put(type, r);
          } else links.push({ r, old });
        } else if (op.op === "annotate_input") {
          assert(
            Object.hasOwn(change.expect, op.id),
            "Expected source required",
          );
          assert(!touched.has(op.id), "Duplicate source mutation");
          touched.add(op.id);
          const r = this.raw(op.id);
          assert(this.head(op.id)?.record_type === "input", "Unknown source");
          r.origin_group = op.origin_group;
          r.observed_at = op.observed_at;
          r.revision++;
          this.validateRecord("input", r);
          this.put("input", r);
          changed.add(op.id);
        } else if (op.op === "withdraw_input") {
          assert(!touched.has(op.id), "Duplicate source mutation");
          touched.add(op.id);
          assert(
            Object.hasOwn(change.expect, op.id),
            "Expected source required",
          );
          const r = this.raw(op.id);
          assert(
            this.head(op.id)?.record_type === "input" &&
              r.state === "available",
            "Unknown active source",
          );
          r.state = "withdrawn";
          r.revision++;
          this.put("input", r);
          changed.add(op.id);
        } else if (op.op === "review") reviews.push(op);
        else if (op.op === "unit") {
          const { source: s, chars } = readSource(op.input_id);
          text(op.key, "unit key");
          text(op.reason, "unit reason");
          assert(
            Object.hasOwn(change.expect, s.id) || touched.has(s.id),
            "Expected unit source required",
          );
          const guardKey = canonical([op.input_id, op.key]);
          assert(
            Object.hasOwn(change.expect_units || {}, guardKey),
            "Expected unit state required",
          );
          assert(
            ["integrated", "evidence-only", "unknown", "out-of-scope"].includes(
              op.outcome,
            ),
            "Unit outcome",
          );
          assert(
            Number.isSafeInteger(op.start) &&
              Number.isSafeInteger(op.end) &&
              op.start >= 0 &&
              op.start < op.end &&
              op.end <= chars.length,
            "Unit range",
          );
          assert(
            Array.isArray(op.targets) &&
              op.targets.every(
                (id) =>
                  this.head(id)?.record_type === "memory" &&
                  (Object.hasOwn(change.expect, id) || touched.has(id)),
              ),
            "Unit targets",
          );
          if (op.outcome === "integrated")
            assert(op.targets.length, "Integrated unit needs memory");
          const old = this.db
            .prepare(
              "SELECT start,end FROM memory_units WHERE input_id=? AND key=?",
            )
            .get(op.input_id, op.key);
          assert(
            !old || (old.start === op.start && old.end === op.end),
            "Unit boundary is immutable",
          );
          this.db
            .prepare(
              "INSERT INTO memory_units VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(input_id,key) DO UPDATE SET outcome=excluded.outcome,targets=excluded.targets,reason=excluded.reason,actor=excluded.actor",
            )
            .run(
              op.input_id,
              op.key,
              op.start,
              op.end,
              op.outcome,
              canonical(op.targets),
              op.reason,
              change.actor,
            );
        } else if (op.op === "use") {
          text(op.task_id, "task_id");
          assert(
            this.head(op.id)?.record_type === "memory",
            "Usage memory missing",
          );
          this.db
            .prepare("INSERT OR IGNORE INTO memory_usage VALUES(?,?,?,?)")
            .run(op.task_id, op.id, change.recorded_at, change.actor);
        } else if (op.op === "invalidate") {
          assert(
            Object.hasOwn(change.expect, op.id),
            "Expected memory required",
          );
          changed.add(op.id);
        } else throw new Error("Unknown operation");
      }
      for (const { r, old } of links) {
        for (const id of [
          r.source,
          r.target,
          ...r.basis.map((b) => b.input_id),
        ])
          assert(
            Object.hasOwn(change.expect, id) || touched.has(id),
            "Expected endpoint/basis required: " + id,
          );
        this.validateRecord("link", r, readSource);
        this.put("link", r);
        if (r.type !== "related") changed.add(semanticDependent(r));
        if (old && old.type !== "related") changed.add(semanticDependent(old));
      }
      const affected = this.invalidate(changed);
      assert(
        !reviews.length || (!changed.size && !touched.size),
        "Review must be separate",
      );
      const reviewing = new Set(reviews.map((o) => o.id));
      assert(reviewing.size === reviews.length, "Duplicate review");
      for (const op of reviews) {
        const r = this.raw(op.id),
          p = this.proof(op.id);
        assert(
          Object.hasOwn(change.expect, op.id) &&
            r?.state === "current" &&
            op.token === p.token,
          "Review token/state conflict",
        );
        text(op.reason, "Review reason");
        for (const link of p.links)
          if (link.state === "current")
            for (const b of link.basis)
              assert(
                this.head(b.input_id)?.state === "available",
                "Withdrawn active basis: " + b.input_id,
              );
        for (const n of p.nodes)
          if (kinds.has(n.kind) && !reviewing.has(n.id))
            assert(
              !n.review_required && n.state === "current",
              "Unreviewed premise: " + n.id,
            );
      }
      for (const op of reviews) {
        const r = this.raw(op.id);
        r.review_required = false;
        this.put("memory", r);
      }
      for (const op of reviews) {
        const r = this.raw(op.id);
        r.review = {
          actor: change.actor,
          reason: op.reason,
          token: this.proof(op.id).token,
        };
        this.put("memory", r);
      }
      const result = {
        request_id: change.request_id,
        affected,
        reviewed: [...reviewing],
        changed: [...touched],
        recorded_at: change.recorded_at,
      };
      this.db
        .prepare("INSERT INTO memory_requests VALUES(?,?,?,?)")
        .run(change.request_id, h, canonical(change), canonical(result));
      const members = new Set([
        ...touched,
        ...affected,
        ...reviewing,
        ...change.operations.flatMap((o) =>
          [o.id, o.input_id, ...(o.targets || [])].filter(Boolean),
        ),
      ]);
      for (const id of members)
        if (this.head(id))
          this.db
            .prepare("INSERT INTO memory_change_members VALUES(?,?)")
            .run(change.request_id, id);
      if (this.afterChange) this.afterChange(change, result, this);
      return result;
    }, true);
  }
  receipt(id) {
    return json(
      this.db
        .prepare("SELECT result data FROM memory_requests WHERE id=?")
        .get(id),
    );
  }
  history(id, { limit = 30, offset = 0 } = {}) {
    assert(
      Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 200 &&
        Number.isSafeInteger(offset) &&
        offset >= 0,
      "History page",
    );
    return this.db
      .prepare(
        "SELECT json_extract(q.request,'$.actor') actor,json_extract(q.request,'$.reason') reason,json_extract(q.request,'$.recorded_at') at,q.id, q.result FROM memory_change_members m JOIN memory_requests q ON q.id=m.request_id WHERE m.record_id=? ORDER BY q.rowid DESC LIMIT ? OFFSET ?",
      )
      .all(id, limit, offset)
      .map((r) => ({ ...r, result: JSON.parse(r.result) }));
  }
  evidence(id) {
    const m = this.raw(id);
    assert(m?.context, "Unknown memory");
    const groups = { supports: new Set(), opposes: new Set() };
    for (const l of this.links(id)) {
      if (
        l.target !== id ||
        l.state !== "current" ||
        !groups[l.type] ||
        canonical(l.context) !== canonical(m.context)
      )
        continue;
      const s = this.head(l.source);
      if (
        s?.record_type === "input" &&
        s.state === "available" &&
        s.origin_group
      )
        groups[l.type].add(s.origin_group);
    }
    const conflict = [...groups.supports].filter((x) => groups.opposes.has(x));
    return {
      support_groups: [...groups.supports]
        .filter((x) => !conflict.includes(x))
        .sort(cpCompare),
      opposition_groups: [...groups.opposes]
        .filter((x) => !conflict.includes(x))
        .sort(cpCompare),
      conflict_groups: conflict.sort(cpCompare),
      usage_count: this.db
        .prepare("SELECT count(*) n FROM memory_usage WHERE memory_id=?")
        .get(id).n,
    };
  }
  inspect(id) {
    const r = this.record(id);
    assert(r, "Unknown memory record");
    if (r.record_type === "input")
      return {
        ...this.source(id),
        read_token: this.guard([id])[id],
        units: this.db
          .prepare("SELECT * FROM memory_units WHERE input_id=? ORDER BY start")
          .all(id),
      };
    if (r.record_type === "link")
      return { ...r, read_token: this.guard([id])[id] };
    const proof = this.proof(id);
    return {
      ...r,
      links: this.links(id),
      evidence: this.evidence(id),
      read_token: proof.token,
      review_token: proof.token,
      fresh: !r.review_required && r.review?.token === proof.token,
    };
  }
  list({ scope = null, query = null, offset = 0, limit = 30 } = {}) {
    assert(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 200,
      "Invalid page",
    );
    const where = ["r.type='memory'"],
      args = [];
    if (scope) {
      where.push("r.scope=?");
      args.push(scope);
    }
    if (query?.trim()) {
      const q = query.trim();
      if (Array.from(q).length >= 3) {
        where.push(
          "r.id IN (SELECT id FROM memory_search WHERE memory_search MATCH ?)",
        );
        args.push('"' + q.replaceAll('"', '""') + '"');
      } else {
        where.push("instr(r.text,?)>0");
        args.push(q);
      }
    }
    const condition = where.join(" AND "),
      total = this.db
        .prepare("SELECT count(*) n FROM memory_records r WHERE " + condition)
        .get(...args).n;
    const records = this.db
      .prepare(
        "SELECT data FROM memory_records r WHERE " +
          condition +
          " ORDER BY r.id LIMIT ? OFFSET ?",
      )
      .all(...args, limit, offset)
      .map(json);
    return { total, offset, limit, records };
  }
  recall(query, { scope = null, limit = 20, hops = 2 } = {}) {
    assert(
      Number.isSafeInteger(hops) && hops >= 0 && hops <= 8,
      "Invalid recall depth",
    );
    const seeds = this.list({ scope, query, limit }),
      seen = new Set(),
      pending = seeds.records.map((r) => ({ id: r.id, depth: 0 })),
      records = [],
      links = new Map();
    while (pending.length) {
      const { id, depth } = pending.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const r = this.record(id);
      if (r?.record_type !== "memory" || (scope && r.context.scope !== scope))
        continue;
      records.push(this.inspect(id));
      if (depth >= hops) continue;
      for (const l of this.links(id)) {
        if (l.state !== "current") continue;
        links.set(l.id, l);
        const next = l.source === id ? l.target : l.source;
        if (this.head(next)?.record_type === "memory")
          pending.push({ id: next, depth: depth + 1 });
      }
    }
    // Personalized graph activation ranks recall relevance, never evidential belief.
    const graphLinks = [...links.values()],
      ids = new Set(records.map((r) => r.id)),
      adj = new Map([...ids].map((id) => [id, []]));
    for (const l of graphLinks)
      if (ids.has(l.source) && ids.has(l.target)) {
        adj.get(l.source).push(l.target);
        adj.get(l.target).push(l.source);
      }
    const seedsHere = seeds.records.filter((r) => ids.has(r.id)),
      initial = new Map(
        [...ids].map((id) => [
          id,
          seedsHere.some((r) => r.id === id)
            ? 1 / Math.max(1, seedsHere.length)
            : 0,
        ]),
      );
    let activation = new Map(initial);
    for (let step = 0; step < 50; step++) {
      const next = new Map([...ids].map((id) => [id, 0.15 * initial.get(id)]));
      let dangling = 0;
      for (const [id, score] of activation) {
        const to = adj.get(id);
        if (to.length)
          for (const target of to)
            next.set(target, next.get(target) + (0.85 * score) / to.length);
        else dangling += 0.85 * score;
      }
      for (const id of ids)
        next.set(id, next.get(id) + dangling * initial.get(id));
      const error = [...ids].reduce(
        (n, id) => n + Math.abs(next.get(id) - activation.get(id)),
        0,
      );
      activation = next;
      if (error < 1e-9) break;
    }
    for (const r of records) r.recall_activation = activation.get(r.id);
    records.sort(
      (a, b) =>
        b.recall_activation - a.recall_activation || cpCompare(a.id, b.id),
    );
    return {
      query,
      scope,
      seeds: seeds.records.map((r) => r.id),
      seed_total: seeds.total,
      records,
      links: graphLinks,
      depth: hops,
      more_seeds: seeds.total > limit,
      activation_semantics: "query_relevance_not_truth",
    };
  }
  stats() {
    return {
      records: this.db
        .prepare("SELECT type,count(*) n FROM memory_records GROUP BY type")
        .all(),
      pending: this.db
        .prepare(
          "SELECT count(*) n FROM memory_records WHERE type='memory' AND json_extract(data,'$.review_required')=1",
        )
        .get().n,
      units: this.db
        .prepare("SELECT outcome,count(*) n FROM memory_units GROUP BY outcome")
        .all(),
      changes: this.db.prepare("SELECT count(*) n FROM memory_requests").get()
        .n,
    };
  }
}

export function openMemory(file) {
  assert(fs.existsSync(file), "Existing authority database required");
  const store = new MemoryStore(file);
  store.db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;");
  return store;
}
