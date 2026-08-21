import assert from "node:assert/strict";
import test from "node:test";

import { buildFormalJobs, pairedSeed, validateQualification } from "./formal-manifest.mjs";

test("formal jobs pair arm seeds within each task repeat and sort deterministically", () => {
  const jobs = buildFormalJobs(["task-a", "task-b"]);
  assert.equal(jobs.length, 12);
  assert.deepEqual(jobs.map(({ orderKey }) => orderKey), jobs.map(({ orderKey }) => orderKey).toSorted());
  for (const taskId of ["task-a", "task-b"]) {
    for (const repeat of [0, 1]) {
      const block = jobs.filter((job) => job.taskId === taskId && job.repeat === repeat);
      assert.equal(block.length, 3);
      assert.equal(new Set(block.map(({ seed }) => seed)).size, 1);
      assert.equal(block[0].seed, pairedSeed(taskId, repeat));
    }
  }
});

test("qualification requires three valid no-op failures and gold passes", () => {
  const result = (nativeVerifierPass, passed) => ({ infrastructureValid: true, nativeVerifierPass, passed, total: 3, runnerErrors: null });
  const record = {
    schemaVersion: "skillscope.senior-swe.qualification.v1",
    taskId: "task-a",
    image: "verifier",
    quickGatePass: true,
    attempts: Array.from({ length: 3 }, () => ({ noop: { result: result(false, 2) }, gold: { result: result(true, 3) } })),
  };
  assert.deepEqual(validateQualification(record, { taskId: "task-a", verifierImage: "verifier" }).noopScores, ["2/3", "2/3", "2/3"]);
  record.attempts[2].gold.result.nativeVerifierPass = false;
  assert.throws(() => validateQualification(record, { taskId: "task-a", verifierImage: "verifier" }), /invalid gold result/u);
});
