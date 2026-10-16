// SPDX-License-Identifier: Apache-2.0
// Independent JavaScript reader of the Python reference snapshot profile.
// This is not an importer of runtime journals or an authorization boundary.
import { createHash } from 'node:crypto';
import { validateModelShape } from './store.mjs';

const check = (ok, why) => { if (!ok) throw new Error(why); };
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const compare = (a, b) => {
  const x = Array.from(a, c => c.codePointAt(0)), y = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

// Build text directly: JSON.stringify(object) reorders integer-like keys.
export function encodeSnapshot(value) {
  const ancestors = new Set();
  function encode(v) {
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') { check(v.isWellFormed(), 'Invalid Unicode scalar'); return JSON.stringify(v); }
    if (typeof v === 'number') { check(Number.isSafeInteger(v), 'Snapshot numbers must be safe integers'); return String(v); }
    check(v && typeof v === 'object' && !ancestors.has(v), 'Invalid or cyclic JSON value');
    ancestors.add(v);
    check(!Object.getOwnPropertySymbols(v).length, 'Symbol keys are not JSON');
    let result;
    if (Array.isArray(v)) {
      check(Object.keys(v).length === v.length, 'Sparse or decorated array');
      const items = [];
      for (let i = 0; i < v.length; i++) { check(Object.hasOwn(v, i), 'Sparse array'); items.push(encode(v[i])); }
      result = '[' + items.join(',') + ']';
    } else {
      check([Object.prototype, null].includes(Object.getPrototypeOf(v)), 'Not a JSON object');
      const keys = Object.keys(v).sort(compare);
      result = '{' + keys.map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        check(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'Not a JSON data property');
        return encode(key) + ':' + encode(descriptor.value);
      }).join(',') + '}';
      check(Object.getOwnPropertyNames(v).length === keys.length, 'Hidden JSON property');
    }
    ancestors.delete(v);
    return result;
  }
  return encode(value);
}

const index = snapshot => new Map(['inputs', 'memories', 'links'].flatMap(key => snapshot[key].map(r => [r.id, r])));
const dependent = link => link.type === 'requires' ? link.source : link.target;
function closure(snapshot, id) {
  const seen = new Set(), pending = [id];
  while (pending.length) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    for (const link of snapshot.links) if (link.state === 'current' && link.type !== 'related' && dependent(link) === next)
      pending.push(link.type === 'requires' ? link.target : link.source);
  }
  return seen;
}

export function snapshotReviewToken(snapshot, id) {
  check(snapshot.memories.some(r => r.id === id), 'Unknown review memory');
  const records = index(snapshot), nodes = closure(snapshot, id), links = [];
  for (const link of snapshot.links) if (link.type !== 'related' && nodes.has(dependent(link))) {
    links.push(link);
    for (const basis of link.basis) nodes.add(basis.input_id);
  }
  const selected = [...nodes].sort(compare).map(key => {
    check(records.has(key), 'Missing dependency');
    const r = structuredClone(records.get(key));
    delete r.review;
    if (key === id) delete r.review_required;
    return r;
  });
  return hash(encodeSnapshot({profile: 'memory-architecture/0.1', nodes: selected, links: links.sort((a, b) => compare(a.id, b.id))}));
}

export function validateSnapshot(snapshot) {
  encodeSnapshot(snapshot);
  validateModelShape(snapshot);
  const records = index(snapshot);
  check(records.size === snapshot.inputs.length + snapshot.memories.length + snapshot.links.length, 'Duplicate identifier');
  const inputs = new Map(snapshot.inputs.map(r => [r.id, r])), memories = new Map(snapshot.memories.map(r => [r.id, r]));
  for (const r of inputs.values()) check(hash(r.text) === r.sha256, 'Source hash mismatch');
  for (const r of [...memories.values(), ...snapshot.links]) {
    const c = r.context;
    if (c.valid_from && c.valid_until) check(Date.parse(c.valid_from) < Date.parse(c.valid_until), 'Invalid validity interval');
  }
  for (const link of snapshot.links) {
    if (inputs.has(link.source)) {
      check(memories.has(link.target) && ['context', 'supports', 'opposes'].includes(link.type), 'Input link boundary');
      check(link.basis.length && link.basis.every(b => b.input_id === link.source), 'Direct source basis required');
    } else {
      check(memories.has(link.source) && memories.has(link.target) && link.source !== link.target && link.type !== 'context', 'Memory link boundary');
      if (link.state === 'current' && link.type !== 'related') check(link.basis.length, 'Semantic relation basis required');
    }
    if (link.state === 'current') check(link.review !== null, 'Current link review required');
    for (const b of link.basis) {
      const r = inputs.get(b.input_id);
      check(r && r.sha256 === b.sha256, 'Basis source mismatch');
      const text = Array.from(r.text);
      check(b.start < b.end && b.end <= text.length && text.slice(b.start, b.end).join('') === b.quote, 'Basis position mismatch');
    }
  }
  for (const r of memories.values()) if (r.state === 'current' && !r.review_required) {
    check(r.review && r.review.token === snapshotReviewToken(snapshot, r.id), 'Missing or stale review');
    for (const id of closure(snapshot, r.id)) if (id !== r.id && memories.has(id)) {
      const premise = memories.get(id);
      check(premise.state === 'current' && !premise.review_required, 'Unreviewed premise');
    }
  }
  return snapshot;
}
