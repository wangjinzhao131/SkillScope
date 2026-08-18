import assert from "node:assert/strict";
import test from "node:test";

import { captureImplementationIdentity } from "../src/implementation-identity.mjs";
import {
  buildResourceSetPlan,
  buildResourceSetTasks,
  loadResourceSetSuite,
  scriptedSmoke,
} from "./executor.mjs";

test("repository snapshot tasks freeze two visible assertions across 24 candidate files", async () => {
  const suite = await loadResourceSetSuite();
  const tasks = await buildResourceSetTasks(suite, { catalogMode: "files" });
  assert.equal(tasks.length, 6);
  for (const task of tasks) {
    assert.equal(task.inferredCatalog.length, 24);
    assert.equal(task.requiredEvidence.length, 2);
    assert.equal(task.evidenceAssertions.length, 2);
    const files = new Map(task.virtualProject.files.map((file) => [file.path, file.content]));
    for (const assertion of task.evidenceAssertions) {
      const line = files.get(assertion.path).split("\n")[assertion.startLine - 1];
      assert.ok(line.includes(assertion.contains));
      assert.equal(assertion.startLine, assertion.endLine);
    }
  }
});

test("plan freezes 48 paired jobs and isolates ResourceSet as an outer experiment factor", async () => {
  const suite = await loadResourceSetSuite();
  const planned = await buildResourceSetPlan({
    suite,
    repeats: 2,
    seed: "resource-set-plan-test",
    model: "scripted-resource-set",
    apiBase: "local://resource-set",
    providerProtocol: "scripted",
    implementationIdentity: captureImplementationIdentity({ allowDirty: true }),
  });
  assert.equal(planned.descriptor.jobCount, 48);
  assert.equal(planned.descriptor.cells.length, 4);
  const exactJobs = planned.jobsByCell.get("EXACT_FILES_24");
  const setJobs = planned.jobsByCell.get("RESOURCE_SET_24");
  assert.deepEqual(setJobs.map((job) => job.jobId), exactJobs.map((job) => job.jobId));
  const setCell = planned.descriptor.cells.find((cell) => cell.id === "RESOURCE_SET_24");
  for (const job of setJobs) {
    const resourceSets = setCell.resourceSetsByTask[job.taskId];
    assert.equal(resourceSets.length, 1);
    assert.equal(resourceSets[0].members.length, 24);
    assert.deepEqual(
      new Set(resourceSets[0].members),
      new Set(job.initialGrantOverride.map((grant) => grant.path)),
    );
  }
});

test("scripted worker uses ResourceSet search and passes provenance without widening grants", async () => {
  const result = await scriptedSmoke();
  assert.deepEqual(result, {
    ok: true,
    hardPass: true,
    policyPass: true,
    searchSetCalls: 1,
    grantedFiles: 24,
    canaryVisible: false,
  });
});
