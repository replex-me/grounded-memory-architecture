// SPDX-License-Identifier: Apache-2.0
// Synthetic examples only; the temporary database is removed after the demonstration.
import fs from "node:fs";
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
const apply = (request_id, reason, changes) =>
  store.apply(
    prepareEvolution(store, {
      request_id,
      actor,
      recorded_at,
      reason,
      ...changes,
    }),
  );
try {
  const one = source(
    "trial-1",
    "The process completed an ordinary request.",
    "trial-1",
  );
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
      sources: [one],
      memories: [method, procedure],
      links: [
        link("support-1", one.id, method.id, "supports", one),
        link("prerequisite", procedure.id, method.id, "requires", one),
      ],
    },
  );
  const group = ["method", "procedure"];
  store.apply({
    request_id: "review-1",
    actor,
    recorded_at,
    reason: "Read evidence and dependent conditions together",
    expect: store.guard(group),
    operations: group.map((id) => ({
      op: "review",
      id,
      token: store.proof(id).token,
      reason: "Verified the stated scope; not a claim of universal performance",
    })),
  });
  const summary = source(
    "summary-1",
    "A summary of the same successful trial.",
    "trial-1",
  );
  apply("repeated-summary", "A restatement is not an independent trial", {
    sources: [summary],
    links: [
      link("support-summary", summary.id, method.id, "supports", summary),
    ],
  });
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
  console.log(
    JSON.stringify(
      {
        phase: "counterexample",
        independentEvidence: store.evidence(method.id),
        affected: receipt.affected,
        dependentNeedsReview: !store.inspect(procedure.id).fresh,
      },
      null,
      2,
    ),
  );
  apply(
    "refine",
    "The failure exposes an input condition; revise the meaning rather than merely lower a score",
    {
      memories: [
        {
          ...method,
          text: "This process can complete requests only when the required input is available.",
          context: { ...context, condition: "required input available" },
        },
      ],
    },
  );
  store.close();
  store = new MemoryStore(file);
  console.log(
    JSON.stringify(
      {
        phase: "after-restart",
        memory: store.inspect(method.id).text,
        history: store.history(method.id).map((h) => h.reason),
        savedRequest: store.receipt("counterexample").request_id,
        recall: store
          .recall("process")
          .records.map((r) => ({
            id: r.id,
            fresh: r.fresh,
            activation: r.recall_activation,
          })),
        originalPreserved: store.source(one.id).text === one.text,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  fs.rmSync(folder, { recursive: true, force: true });
}
