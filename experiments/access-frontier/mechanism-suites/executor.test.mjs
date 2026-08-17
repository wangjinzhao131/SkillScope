import assert from "node:assert/strict";
import test from "node:test";

import { captureImplementationIdentity } from "../src/implementation-identity.mjs";
import { loadTasks } from "../src/jsonl.mjs";
import {
  buildForcedUndergrantPlan,
  CONTROL_CONDITION,
  loadForcedUndergrantSuite,
  runScriptedMechanismSmoke,
  TREATMENT_CONDITION,
} from "./executor.mjs";

const tasksPath = new URL("../tasks/cases/", import.meta.url).pathname;

test("plan freezes one identical undergrant across the two independent arms", async () => {
  const suite = await loadForcedUndergrantSuite();
  const tasks = await loadTasks(tasksPath);
  const { jobs, descriptor } = await buildForcedUndergrantPlan({
    suite: { ...suite, probes: [suite.probes[0]] },
    tasks,
    repeats: 2,
    seed: "mechanism-plan-test",
    model: "scripted-plan",
    apiBase: "local://mechanism-plan",
    providerProtocol: "scripted",
    implementationIdentity: captureImplementationIdentity({ allowDirty: true }),
  });
  assert.equal(jobs.length, 4);
  assert.equal(descriptor.jobCount, 4);
  assert.deepEqual(new Set(jobs.map((job) => job.condition)), new Set([CONTROL_CONDITION, TREATMENT_CONDITION]));
  assert.ok(jobs.every((job) => job.taskId.startsWith("af-forced-undergrant-")));
  assert.ok(jobs.every((job) => job.initialGrantOverride.length === 1));
  for (const repeat of [0, 1]) {
    const pair = jobs.filter((job) => job.repeat === repeat);
    assert.equal(new Set(pair.map((job) => job.seed)).size, 1);
    assert.equal(new Set(pair.map((job) => JSON.stringify(job.initialGrantOverride))).size, 1);
    assert.equal(new Set(pair.map((job) => job.jobId)).size, 2);
  }
});

test("scripted paired smoke proves no-expansion failure and NEED fresh-rerun recovery", async () => {
  const smoke = await runScriptedMechanismSmoke();
  assert.equal(smoke.ok, true);
  assert.ok(Object.values(smoke.checks).every(Boolean));
  assert.equal(smoke.summary.eligiblePairs, 1);
  assert.equal(smoke.summary.recoveredPairCount, 1);
  assert.equal(smoke.summary.treatmentFreshRerunCount, 1);
});
