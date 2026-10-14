// SPDX-License-Identifier: Apache-2.0
// Portable core journal. Does not export adapter tables or grant authorization.
import { digest, canonical } from './store.mjs';
const format = 'gma-journal/1';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
function state(store) {
  const records = store.db.prepare('SELECT type,data FROM memory_records ORDER BY id').all()
    .map(r => ({ type: r.type, record: JSON.parse(r.data) }));
  for (const r of records) if (r.type === 'input') store.source(r.record.id);
  return {
    records,
    units: store.db.prepare('SELECT * FROM memory_units ORDER BY input_id,key').all()
      .map(r => ({ ...r, targets: JSON.parse(r.targets) })),
    usage: store.db.prepare('SELECT * FROM memory_usage ORDER BY task_id,memory_id').all(),
  };
}
export function exportArchive(store) {
  return store.transaction(() => {
    const payload = {
      format, profile: 'memory-store/1',
      requests: store.db.prepare('SELECT hash,request,result FROM memory_requests ORDER BY rowid').all()
        .map(r => ({ hash: r.hash, change: JSON.parse(r.request), result: JSON.parse(r.result) })),
      state_digest: digest(state(store)),
    };
    for (const entry of payload.requests)
      requireValue(digest(entry.change) === entry.hash, 'Stored request corruption');
    return { ...payload, integrity: digest(payload) };
  });
}
export function importArchive(store, archive) {
  // Clone before replay: caller mutation cannot change the checked payload.
  const checked = JSON.parse(canonical(archive));
  requireValue(checked && Object.keys(checked).sort().join(',') ===
    'format,integrity,profile,requests,state_digest', 'Archive shape');
  requireValue(checked.format === format && checked.profile === 'memory-store/1', 'Archive profile');
  requireValue(Array.isArray(checked.requests), 'Archive requests');
  const { integrity, ...payload } = checked;
  requireValue(digest(payload) === integrity, 'Archive integrity');
  const ids = new Set();
  for (const entry of checked.requests) {
    requireValue(entry && Object.keys(entry).sort().join(',') === 'change,hash,result', 'Journal entry shape');
    requireValue(entry.change && typeof entry.change.request_id === 'string', 'Journal request');
    requireValue(!ids.has(entry.change.request_id), 'Duplicate journal request');
    ids.add(entry.change.request_id);
    requireValue(digest(entry.change) === entry.hash, 'Journal request hash');
  }
  return store.transaction(() => {
    for (const table of ['memory_records', 'memory_requests', 'memory_units', 'memory_usage'])
      requireValue(store.db.prepare('SELECT count(*) n FROM ' + table).get().n === 0,
        'Archive import requires an empty memory store');
    for (const entry of checked.requests) {
      const result = store.apply(entry.change);
      requireValue(digest(result) === digest(entry.result), 'Journal result mismatch');
    }
    requireValue(digest(state(store)) === checked.state_digest, 'Replayed state mismatch');
    return { format, requests: checked.requests.length, state_digest: checked.state_digest };
  }, true);
}
