// SPDX-License-Identifier: Apache-2.0
// Read-only comparison boundary. Adapters retrieve; reviewers judge meaning.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {referenceRecord} from '../runtime/retrieval.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
export const fingerprint = value => hash(JSON.stringify(value));
const cp = value => Array.from(value);
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const nonempty = s => typeof s === 'string' && s.trim() && s.isWellFormed();

export function sealProtocol(protocol) {
  assert.equal(protocol.format, 'gma-comparison/1');
  assert.equal(protocol.response_view, 'complete-meaning-source-refs/1');
  assert.ok(nonempty(protocol.purpose));
  assert.ok(integer(protocol.budget.records, 1, 500));
  assert.ok(integer(protocol.budget.codepoints, 1, 10_000_000));
  assert.ok(protocol.queries.length && protocol.phases.length && protocol.arms.length >= 2);
  for (const list of [protocol.queries, protocol.phases, protocol.arms])
    assert.equal(new Set(list.map(x => x.id)).size, list.length, 'Duplicate protocol ID');
  for (const q of protocol.queries) {
    assert.ok(nonempty(q.id) && nonempty(q.question));
    assert.ok(q.terms.length && q.terms.every(nonempty));
  }
  for (const phase of protocol.phases) {
    assert.ok(nonempty(phase.id) && phase.inputs.length);
    assert.equal(new Set(phase.inputs.map(x => x.id)).size, phase.inputs.length);
    for (const input of phase.inputs)
      assert.ok(nonempty(input.id) && /^[a-f0-9]{64}$/.test(input.sha256));
  }
  for (const arm of protocol.arms)
    assert.ok(nonempty(arm.id) && nonempty(arm.method));
  // Clone now, before any retrieval; a caller cannot rewrite questions after seeing results.
  const copy = JSON.parse(JSON.stringify(protocol));
  return {protocol: copy, sha256: fingerprint(copy)};
}

export function literalRank(records, terms) {
  const needles = [...new Set(terms.map(t => t.normalize('NFC').toLowerCase()))];
  return records.map(record => {
    const text = record.text.normalize('NFC').toLowerCase();
    return {record, score: needles.filter(term => text.includes(term)).length};
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0))
    .map(x => x.record);
}

function evidence(record, manifest, source, verifyQuote = true) {
  assert.ok(nonempty(record.id) && typeof record.text === 'string');
  const basis = record.basis || record.links?.filter(l => l.state === 'current').flatMap(l => l.basis);
  assert.ok(Array.isArray(basis) && basis.length, 'Untraceable result');
  for (const b of basis) {
    assert.equal(manifest.get(b.input_id), b.sha256, 'Result outside pinned input universe');
    if (!verifyQuote) continue;
    const text = source(b.input_id);
    const chars = cp(text);
    assert.ok(integer(b.start, 0, chars.length) && integer(b.end, b.start + 1, chars.length));
    assert.equal(chars.slice(b.start, b.end).join(''), b.quote, 'Incorrect source selector');
  }
}

export async function compare(sealed, adapters, sourceForPhase) {
  const runBegan = performance.now();
  assert.equal(fingerprint(sealed.protocol), sealed.sha256, 'Protocol changed');
  const protocol = JSON.parse(JSON.stringify(sealed.protocol));
  assert.deepEqual(Object.keys(adapters).sort(), protocol.arms.map(a => a.id).sort(), 'Missing comparison arm');
  const results = [], phasePreparation = [];
  for (const phase of protocol.phases) {
    const phaseBegan = performance.now();
    const manifest = new Map(phase.inputs.map(x => [x.id, x.sha256]));
    // Pin and verify each original once, not once per matching/deferred paragraph.
    const originals = new Map(phase.inputs.map(input => {
      const text = sourceForPhase(phase.id, input.id);
      assert.equal(hash(text), input.sha256, 'Pinned source changed');
      return [input.id, text];
    }));
    phasePreparation.push({phase: phase.id, pinned_source_validation_ms: performance.now() - phaseBegan,
      pinned_source_codepoints: [...originals.values()].reduce((n, s) => n + cp(s).length, 0)});
    for (const query of protocol.queries) {
      // Rotate order by question, avoiding a permanently privileged warm-cache arm.
      const rotation = protocol.queries.indexOf(query) % protocol.arms.length;
      const arms = [...protocol.arms.slice(rotation), ...protocol.arms.slice(0, rotation)];
      for (const arm of arms) {
        const began = performance.now();
        const response = await adapters[arm.id]({phase: structuredClone(phase), query: structuredClone(query), budget: {...protocol.budget}});
        const retrieval_ms = performance.now() - began;
        assert.equal(response.input_manifest_sha256, fingerprint(phase.inputs), 'Adapter input mismatch');
        assert.ok(Array.isArray(response.records));
        assert.equal(new Set(response.records.map(r => r.id)).size, response.records.length, 'Duplicate result');
        let used = 0;
        const returned = [], deferred = [];
        for (const record of response.records) {
          evidence(record, manifest, id => originals.get(id), false);
          // Original text stays in the source. Return exact, resolvable references,
          // not another full copy of every dependency's original in each result.
          const rendered = referenceRecord(record);
          const size = cp(JSON.stringify(rendered)).length;
          if (returned.length >= protocol.budget.records || used + size > protocol.budget.codepoints) {
            deferred.push({id: record.id, codepoints: size});
          } else {
            evidence(record, manifest, id => originals.get(id));
            returned.push(rendered); used += size;
          }
        }
        results.push({phase: phase.id, query: query.id, arm: arm.id, method: arm.method,
          retrieval_ms, elapsed_ms: performance.now() - began, returned_codepoints: used, records: returned, deferred,
          diagnostics: response.diagnostics || {},
          management_cost: response.management_cost ?? null,
          semantic_judgment: null});
      }
    }
  }
  assert.equal(fingerprint(sealed.protocol), sealed.sha256, 'Protocol changed during execution');
  return {format: 'gma-comparison-result/1', protocol_sha256: sealed.sha256, protocol,
    executor_sha256: fingerprint([sealProtocol, literalRank, referenceRecord, evidence, compare].map(f => f.toString())),
    comparisons: results, phase_preparation: phasePreparation, execution_ms: performance.now() - runBegan,
    budget_semantics: 'serialized response with complete meaning/context and exact source references; not total source reading or model tokens',
    evidence_detail: 'resolve pinned source spans; original quote bodies omitted from response only',
    semantic_accuracy: null, independent_review: false,
    end_to_end_management_cost: null, superiority_established: false};
}
