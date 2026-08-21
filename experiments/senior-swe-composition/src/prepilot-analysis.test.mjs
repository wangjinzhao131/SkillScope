import assert from "node:assert/strict";
import test from "node:test";

import { analyzePrepilot } from "./prepilot-analysis.mjs";

const arms = ["INLINE_PERSISTENT", "FLAT_DISPOSABLE", "COMPOSED_DISPOSABLE"];

test("analysis separates resource closure from full composed topology", () => {
  const jobs = arms.map((arm) => ({ taskId: "real-task", arm, seed: 7 }));
  const manifest = {
    schemaVersion: "skillscope.senior-swe.prepilot-manifest.v2",
    implementationCommit: "abc",
    dataset: { commit: "data" },
    model: { id: "model" },
    pairedSeed: 7,
    jobs,
  };
  const records = jobs.map((job) => record(job, job.arm === "INLINE_PERSISTENT" ? 0 : job.arm === "FLAT_DISPOSABLE" ? 1 : 2));
  const result = analyzePrepilot(manifest, records);
  assert.equal(result.totals.allStartedScopesClosed, 3);
  assert.equal(result.totals.topologyComplete, 2);
  assert.equal(result.totals.rawLifecycleValid, 2);
  assert.equal(result.rows.find((row) => row.arm === "COMPOSED_DISPOSABLE").allStartedScopesClosed, true);
  assert.equal(result.rows.find((row) => row.arm === "COMPOSED_DISPOSABLE").topologyComplete, false);
  assert.equal(result.gates.formalExperimentAllowed, false);
});

test("analysis rejects missing, duplicate, and unregistered results", () => {
  const job = { taskId: "real-task", arm: arms[0], seed: 7 };
  const manifest = { schemaVersion: "skillscope.senior-swe.prepilot-manifest.v2", jobs: [job] };
  assert.throws(() => analyzePrepilot(manifest, []), /missing manifest results/u);
  assert.throws(() => analyzePrepilot(manifest, [record(job, 0), record(job, 0)]), /duplicate result/u);
  assert.throws(() => analyzePrepilot(manifest, [record({ ...job, taskId: "other" }, 0)]), /not present/u);
});

function record(job, startedScopes) {
  const expectedScopes = job.arm === "INLINE_PERSISTENT" ? 0 : job.arm === "FLAT_DISPOSABLE" ? 1 : 5;
  return {
    schemaVersion: "skillscope.senior-swe.live-result.v1",
    ...job,
    status: "capability_failure",
    wallTimeMs: 1000,
    stages: [],
    finalArtifact: null,
    nativeVerifier: null,
    context: { rootFinalBytes: 100, rootContextAucBytes: 100, coordinatorFinalBytes: 100, coordinatorContextAucBytes: 100 },
    usage: { apiCalls: 1, totalTokens: 10 },
    lifecycle: {
      expectedScopes,
      startedScopes,
      disposedScopes: startedScopes,
      activeScopes: 0,
      activeContainers: 0,
      valid: startedScopes === expectedScopes,
    },
    leakage: { sentinelInRootProjection: false, rawTranscriptsPersisted: false },
    failure: { code: "MISSING_STAGE_COMPLETE" },
  };
}
