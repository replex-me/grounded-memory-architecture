// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {referenceRecord} from './retrieval.mjs';

test('reference view preserves the entire meaning, condition, state and tokens without copying dependency quotations', () => {
  const quote = 'Original conditions 😀\n'.repeat(5000);
  const source = {input_id:'original', sha256:'0'.repeat(64), start:0, end:Array.from(quote).length, quote};
  const record = {id:'meaning', text:'A long meaning with all exceptions. '.repeat(100),
    context:{condition:'only with the actual receipt'}, state:'current', fresh:false,
    read_token:'unchanged', links:[{id:'origin', revision:1, type:'context', source:'original', target:'meaning', state:'current', basis:[source]}], history:[{id:'change'}]};
  const before = structuredClone(record), view = referenceRecord(record);
  assert.deepEqual(record, before);
  assert.equal(view.text, record.text);
  assert.deepEqual(view.context, record.context);
  assert.equal(view.read_token, record.read_token);
  assert.equal(view.fresh, false);
  assert.equal(view.relation_index.record_id, record.id);
  assert.equal(view.relation_index.total, 1);
  assert.equal(view.relation_index.by_type.context, 1);
  assert.equal(view.relation_index.detail_required, true);
  assert.equal(view.links, undefined);
  const relationView = referenceRecord(record.links[0]);
  assert.equal(relationView.basis_refs[0].quote_sha256, createHash('sha256').update(quote).digest('hex'));
  assert.equal(relationView.basis_refs[0].end, source.end);
  assert.equal(view.history_available, true);
  assert.ok(JSON.stringify(view).length < JSON.stringify(record).length / 10);
});
test('the response projection cannot be used to replace an original input', () => {
  assert.throws(() => referenceRecord({record_type:'input', text:'original'}), /original-source/);
});
