// SPDX-License-Identifier: Apache-2.0
// Synthetic examples only; the temporary database is removed after the demonstration.
import fs from "node:fs";
import assert from "node:assert/strict";
import { exportArchive, importArchive } from "../runtime/archive.mjs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MemoryStore } from "../runtime/store.mjs";
import { prepareEvolution } from "../runtime/evolution.mjs";
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "memory-demo-")),
  file = path.join(folder, "memory.sqlite");
let store = new MemoryStore(file);
store.install();
const actor = "synthetic-reviewer",
  recorded_at = new Date().toISOString(),
  context = {
    scope: "synthetic-team",
    condition: "ordinary requests",
    valid_from: null,
    valid_until: null,
  };
const source = (id, text, group) => ({
  id,
  revision: 1,
  text,
  sha256: createHash("sha256").update(text).digest("hex"),
  source: "urn:synthetic:" + id,
  origin_group: group,
  observed_at: recorded_at,
  recorded_at,
  state: "available",
});
const quote = (s) => ({
  input_id: s.id,
  sha256: s.sha256,
  start: 0,
  end: Array.from(s.text).length,
  quote: s.text,
});
const review = {
  actor,
  reason: "Compared the stated experience with its actual scope",
};
const memory = (id, text, kind = "belief") => ({
  id,
  text,
  kind,
  context,
  state: "current",
});
const link = (id, from, to, type, s) => ({
  id,
  source: from,
  target: to,
  type,
  context,
  state: "current",
  basis: [quote(s)],
  review,
});
const apply = (request_id, reason, changes) => {
  const ids = [];
  for (const m of changes.memories || []) ids.push(m.id);
  for (const l of changes.links || [])
    ids.push(l.id, l.source, l.target, ...l.basis.map((b) => b.input_id));
  // This single-writer demonstration reads every referenced current record before judging.
  const read_set = Object.fromEntries(
    [...new Set(ids)]
      .filter((id) => store.head(id))
      .map((id) => {
        const read = store.inspect(id);
        return [id, read.read_token];
      }),
  );
  return store.apply(
    prepareEvolution(store, {
      request_id,
      actor,
      recorded_at,
      reason,
      ...changes,
      read_set,
    }),
  );
};
const phases = [], comparisonSnapshots = [];
const capture = (phase, id = "method") => {
  const view = store.inspect(id);
  phases.push({ phase, text: view.text, condition: view.context.condition,
    state: view.state, fresh: view.fresh, evidence: view.evidence,
    dependentFresh: store.inspect("procedure").fresh,
    goalFresh: store.inspect('goal').fresh, goalText: store.inspect('goal').text });
  if (process.argv.includes('--comparison-snapshots')) {
    const inputs = store.db.prepare("SELECT data FROM memory_records WHERE type='input' ORDER BY id").all().map(r => JSON.parse(r.data));
    const memories = ['method', 'procedure', 'goal'].map(id => {
      const m = store.inspect(id);
      return {id: m.id, text: m.text, context: m.context, state: m.state, fresh: m.fresh, evidence: m.evidence, links: m.links};
    });
    comparisonSnapshots.push({id: phase, inputs, memories});
  }
};
const reviewTogether = (request_id) => {
  const ids = ["method", "procedure", "goal"];
  const reads = ids.map(id => store.inspect(id));
  store.apply({ request_id, actor, recorded_at,
    reason: "Read all meanings, conditions and all active evidence together",
    expect: Object.fromEntries(reads.map(r => [r.id, r.read_token])),
    operations: reads.map(r => ({ op: "review", id: r.id,
      token: r.review_token, reason: "Verified the actual scope and dependencies" })) });
};
try {
  const one = source(
    "trial-1",
    "The process completed an ordinary request with the required input available.",
    "trial-1",
  );
  const intent = source('team-intent', 'The team intends to make ordinary requests useful and reliable.', null);
  const goal = memory('goal', 'Make ordinary requests useful and reliable.', 'goal');
  const method = memory(
      "method",
      "This process can complete ordinary requests.",
    ),
    procedure = memory(
      "procedure",
      "Use this process when its input condition is met.",
      "procedure",
    );
  apply(
    "initial",
    "Read a completed trial; build a belief and its dependent procedure",
    {
      sources: [one, intent],
      memories: [method, procedure, goal],
      links: [
        link("support-1", one.id, method.id, "supports", one),
        link("prerequisite", procedure.id, method.id, "requires", one),
        link('intent-context', intent.id, goal.id, 'context', intent),
        link('purpose-navigation', procedure.id, goal.id, 'related', intent),
      ],
    },
  );
  reviewTogether("review-1");
  capture("initial-reviewed");
  const summary = source(
    "summary-1",
    "A summary of the same successful trial with the required input available.",
    "trial-1",
  );
  apply("repeated-summary", "A restatement is not an independent trial", {
    sources: [summary],
    links: [
      link("support-summary", summary.id, method.id, "supports", summary),
    ],
  });
  capture("same-event-summary");
  const two = source("trial-3",
    "An independent trial completed an ordinary request with the required input available.", "trial-3");
  apply("independent-success", "A distinct trial adds evidence under the same broad claim", {
    sources: [two], links: [link("support-3", two.id, method.id, "supports", two)] });
  capture("independent-success");
  store.apply({ request_id: "usage", actor, recorded_at,
    reason: "Record use; use is not an observation of success",
    expect: store.guard([method.id]),
    operations: [{ op: "use", id: method.id, task_id: "task-1" }] });
  capture("usage-is-not-evidence");
  const failure = source(
    "trial-2",
    "The process failed on a request with a missing prerequisite.",
    "trial-2",
  );
  const receipt = apply(
    "counterexample",
    "A new failure requires revisiting the belief and dependent procedure",
    {
      sources: [failure],
      links: [link("opposition", failure.id, method.id, "opposes", failure)],
    },
  );
  capture("counterexample");
  const qualified = { ...context, condition: "required input available" };
  const qualifiedLink = (id, from, to, type, basis) => ({
    ...link(id, from, to, type, basis), context: qualified });
  apply("refine",
    "Read both successful trials and the failure: narrow the claim, update its dependent procedure and reclassify each relation", {
    memories: [{ ...method,
      text: "This process can complete ordinary requests when the required input is available; missing-input requests are outside this claim.",
      context: qualified }, { ...procedure,
      text: "Check that the required input is available before using this process; otherwise obtain it or select another method.",
      context: qualified }],
    links: [
      qualifiedLink("support-1", one.id, method.id, "supports", one),
      qualifiedLink("support-summary", summary.id, method.id, "supports", summary),
      qualifiedLink("support-3", two.id, method.id, "supports", two),
      qualifiedLink("prerequisite", procedure.id, method.id, "requires", one),
      { ...link("opposition", failure.id, method.id, "opposes", failure),
        state: "withdrawn", review: { actor,
          reason: "The failure remains a counterexample to the previous broad claim; it does not test the new input-present condition" } }
    ] });
  capture("refined-unreviewed");
  reviewTogether("review-refinement");
  capture("refined-reviewed");
  store.close();
  store = new MemoryStore(file);
  capture("after-restart");
  const [initial, repeated, independent, usage, failed, refined, reviewed, restarted] = phases;
  assert.equal(initial.fresh, true);
  assert.equal(initial.evidence.support_groups.length, 1);
  assert.equal(repeated.evidence.support_groups.length, 1);
  assert.equal(independent.evidence.support_groups.length, 2);
  assert.equal(usage.evidence.support_groups.length, 2);
  assert.equal(usage.evidence.usage_count, 1);
  assert.equal(failed.evidence.opposition_groups.length, 1);
  assert.equal(failed.dependentFresh, false);
  assert.equal(failed.goalFresh, true);
  assert.equal(failed.goalText, initial.goalText);
  assert.equal(refined.fresh, false);
  assert.equal(refined.dependentFresh, false);
  assert.equal(reviewed.fresh, true);
  assert.equal(reviewed.dependentFresh, true);
  assert.equal(reviewed.evidence.support_groups.length, 2);
  assert.equal(reviewed.evidence.opposition_groups.length, 0);
  assert.deepEqual(restarted, { ...reviewed, phase: "after-restart" });
  assert.equal(store.source(failure.id).text, failure.text);
  assert.equal(store.source(one.id).text, one.text);
  assert.ok(store.history(method.id).some(h => h.id === "counterexample"));
  assert.equal(store.receipt("counterexample").request_id, receipt.request_id);
  const archive = exportArchive(store);
  const restored = new MemoryStore(":memory:");
  restored.install();
  try {
    importArchive(restored, JSON.parse(JSON.stringify(archive)));
    assert.deepEqual(restored.inspect(method.id), store.inspect(method.id));
    assert.deepEqual(exportArchive(restored), archive);
  } finally { restored.close(); }
  const report = { archiveRestored: true, phases, assertions: "passed", originalPreserved: true,
    previousCounterexamplePreserved: true,
    savedRequest: store.receipt("counterexample").request_id,
    recall: store.recall("process").records.map(r => ({ id: r.id,
      fresh: r.fresh, activation: r.recall_activation })) };
  if (process.argv.includes('--comparison-snapshots')) {
    console.log(JSON.stringify({synthetic: true, snapshots: comparisonSnapshots}));
  } else if (process.argv.includes("--explain")) {
    const labels = ["첫 성공과 검토", "같은 사건의 재인용", "독립된 두 번째 성공",
      "실제 사용 기록", "새로운 반례", "조건과 의존 절차 정정", "근거 재검토", "재시작"];
    for (const [i, r] of phases.entries()) {
      console.log(`${i + 1}. ${labels[i]}: 지지 ${r.evidence.support_groups.length}, 반박 ${r.evidence.opposition_groups.length}, 사용 ${r.evidence.usage_count}, 검토 ${r.fresh ? "최신" : "필요"}, 의존 절차 ${r.dependentFresh ? "최신" : "재검토 필요"}`);
    }
    console.log("반례는 삭제하지 않았습니다. 새 조건에 대한 반박 연결만 철회했고 이전 주장과 반례의 변경 이력은 남았습니다.");
    console.log("원본 보존·중복 방지·영향 전파·조건 정정·재검토·재시작·별도 저장소 복원 검증 통과");
  } else console.log(JSON.stringify(report, null, 2));

} finally {
  store.close();
  fs.rmSync(folder, { recursive: true, force: true });
}
