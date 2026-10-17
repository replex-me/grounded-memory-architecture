// SPDX-License-Identifier: Apache-2.0
// Controlled synthetic mechanism comparison, not a benchmark of human/agent quality.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compare, sealProtocol, literalRank, fingerprint} from '../evaluation/compare.mjs';

// Fix questions and budgets before generating or reading any results.
const queries = [
  {id: 'apply', question: 'When can the process be used, and what remains unreviewed?', terms: ['process', 'input']},
  {id: 'counterexample', question: 'What failed, and is the current claim narrower?', terms: ['failed', 'missing', 'condition']},
];
const budget = {records: 8, codepoints: 18000};
const demonstration = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./persistent-demo.mjs', import.meta.url)), '--comparison-snapshots'], {encoding: 'utf8'}));
const snapshots = new Map(demonstration.snapshots.map(s => [s.id, s]));
const first = demonstration.snapshots[0];
const sealed = sealProtocol({format: 'gma-comparison/1', response_view: 'complete-meaning-source-refs/1', purpose: 'Controlled synthetic comparison of retrieval and justified updates',
  budget, queries, phases: demonstration.snapshots.map(s => ({id: s.id, inputs: s.inputs.map(i => ({id: i.id, sha256: i.sha256}))})),
  arms: [
    {id: 'documents', method: 'literal union over unmodified source documents'},
    {id: 'source-scan', method: 'exhaustive raw-source reading; no model or agent inference'},
    {id: 'frozen-memory', method: 'same literal union over initial reviewed meanings; no subsequent updates'},
    {id: 'updated-memory', method: 'same literal union over the real persistent core at each phase'},
  ]});
const sourceRecords = snapshot => snapshot.inputs.map(i => ({id: i.id, text: i.text, state: i.state,
  basis: [{input_id: i.id, sha256: i.sha256, start: 0, end: Array.from(i.text).length, quote: i.text}]}));
const adapter = kind => ({phase, query}) => {
  const snapshot = snapshots.get(phase.id);
  let records = kind === 'documents' || kind === 'source-scan' ? sourceRecords(snapshot)
    : kind === 'frozen-memory' ? structuredClone(first.memories) : snapshot.memories;
  if (kind !== 'source-scan') records = literalRank(records, query.terms);
  // A frozen view's old review is explicitly historical, not a current validation.
  if (kind === 'frozen-memory') records = records.map(r => ({...r, review_scope: 'initial snapshot only; later inputs not considered'}));
  return {input_manifest_sha256: fingerprint(phase.inputs), records,
    diagnostics: {synthetic: true, automatic_answering: false, input_count: snapshot.inputs.length,
      graph_update_policy: kind === 'frozen-memory' ? 'disabled' : kind === 'updated-memory' ? 'explicit authored judgments' : 'not applicable'},
    management_cost: null};
};
const result = await compare(sealed, Object.fromEntries(sealed.protocol.arms.map(a => [a.id, adapter(a.id)])),
  (phase, id) => snapshots.get(phase).inputs.find(i => i.id === id).text);
result.scope = 'Authored synthetic mechanism demonstration. No independent semantic or end-user performance evaluation.';
console.log(JSON.stringify(result, null, 2));
