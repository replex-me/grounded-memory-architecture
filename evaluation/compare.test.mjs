// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compare, sealProtocol, literalRank, fingerprint} from './compare.mjs';

const text = '😀 condition: blue. Not valid without a receipt.';
const sha256 = createHash('sha256').update(text).digest('hex');
const inputs = [{id: 'source', sha256}];
const record = {id: 'meaning', text: 'Blue needs a receipt.', state: 'current',
  basis: [{input_id: 'source', sha256, start: 2, end: Array.from(text).length, quote: Array.from(text).slice(2).join('')}]};
const protocol = () => sealProtocol({format: 'gma-comparison/1', response_view: 'complete-meaning-source-refs/1', purpose: 'Synthetic parity and exact evidence',
  budget: {records: 2, codepoints: 2000}, queries: [{id: 'question', question: 'What is required?', terms: ['receipt']}],
  phases: [{id: 'stage', inputs}], arms: [{id: 'documents', method: 'literal union'}, {id: 'memories', method: 'literal union'}]});
const adapter = (records = [record]) => () => ({input_manifest_sha256: fingerprint(inputs), records});

test('same protocol and exact Unicode evidence; never manufacture quality or total-cost scores', async () => {
  const result = await compare(protocol(), {documents: adapter(), memories: adapter()}, () => text);
  assert.equal(result.comparisons.length, 2);
  for (const r of result.comparisons) {
    assert.equal(r.records[0].text, record.text);
    assert.equal(r.records[0].basis_refs[0].input_id, 'source');
    assert.equal(r.records[0].basis_refs[0].start, record.basis[0].start);
    assert.equal(r.records[0].basis_refs[0].quote_sha256, createHash('sha256').update(record.basis[0].quote).digest('hex'));
    assert.equal(r.records[0].basis, undefined);
  }
  assert.equal(result.semantic_accuracy, null);
  assert.equal(result.end_to_end_management_cost, null);
  assert.equal(result.superiority_established, false);
});
test('pinned input changes, out-of-universe origins, missing arms and invalid selectors reject the whole run', async () => {
  await assert.rejects(compare(protocol(), {documents: adapter()}, () => text), /Missing/);
  await assert.rejects(compare(protocol(), {documents: adapter(), memories: adapter()}, () => text + 'changed'), /changed/);
  for (const patch of [{input_id: 'elsewhere'}, {sha256: '0'.repeat(64)}, {start: 1}, {quote: 'fabricated'}]) {
    const bad = structuredClone(record); Object.assign(bad.basis[0], patch);
    await assert.rejects(compare(protocol(), {documents: adapter(), memories: adapter([bad])}, () => text));
  }
  const changed = protocol(); changed.protocol.budget.records = 3;
  await assert.rejects(compare(changed, {documents: adapter(), memories: adapter()}, () => text), /Protocol changed/);
});
test('equal full-context budget defers complete records instead of cutting conditions or quotes', async () => {
  const sealed = protocol(); sealed.protocol.budget.codepoints = 10; sealed.sha256 = fingerprint(sealed.protocol);
  const result = await compare(sealed, {documents: adapter(), memories: adapter()}, () => text);
  for (const r of result.comparisons) { assert.equal(r.records.length, 0); assert.equal(r.deferred[0].id, record.id); }
});
test('rank uses the same literal union, independent of field order and uppercase; no duplicate terms boost', () => {
  const rows = [{id: 'b', text: 'BLUE'}, {id: 'a', text: 'blue receipt'}];
  assert.deepEqual(literalRank(rows, ['Blue', 'receipt', 'Blue']).map(r => r.id), ['a', 'b']);
});
test('a large candidate list verifies each pinned source once and does not reread originals for every deferred result', async () => {
  let reads = 0;
  const rows = Array.from({length: 1000}, (_, n) => ({...record, id: 'candidate-' + n}));
  const result = await compare(protocol(), {documents: adapter(rows), memories: adapter(rows)}, () => { reads++; return text; });
  assert.equal(reads, 1);
  assert.equal(result.comparisons[0].deferred.length, 998);
});
