import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEntropyPlan,
  buildEntropyTasks,
  CELL_DEFINITIONS,
  loadEntropySuite,
  renderEntropyReport,
  summarizeEntropyFrontier,
} from "./executor.mjs";
import { captureImplementationIdentity } from "../src/implementation-identity.mjs";
import { stableStringify } from "../src/protocol.mjs";

test("five high-entropy families satisfy Schema 2 in root and sharded forms", async () => {
  const suite = await loadEntropySuite();
  const sharded = buildEntropyTasks(suite, { catalogMode: "sharded" });
  const root = buildEntropyTasks(suite, { catalogMode: "root" });
  assert.equal(sharded.length, 5);
  assert.equal(root.length, 5);
  for (const task of sharded) {
    assert.equal(task.fixtureSchemaVersion, "2.0");
    assert.equal(task.inferredCatalog.length, 16);
    assert.equal(task.requiredEvidence.length, 2);
    assert.equal(task.virtualProject.files.filter((file) => file.sensitivity === "canary").length, 1);
  }
  for (const task of root) {
    assert.deepEqual(task.inferredCatalog, [{ path: "corpus", kind: "directory", operations: ["list", "read", "search"] }]);
  }
});

test("plan freezes five paired cells with shared seeds and only declared factor changes", async () => {
  const suite = await loadEntropySuite();
  const plan = await buildEntropyPlan({
    suite,
    repeats: 2,
    seed: "entropy-test",
    runId: "entropy-test",
    model: "scripted-entropy",
    apiBase: "local://entropy",
    providerProtocol: "scripted",
    maxRetries: 0,
    implementationIdentity: captureImplementationIdentity({ allowDirty: true }),
  });
  assert.equal(plan.descriptor.jobCount, 50);
  assert.equal(plan.jobsByCell.size, CELL_DEFINITIONS.length);
  const seedMap = new Map();
  for (const definition of CELL_DEFINITIONS) {
    const jobs = plan.jobsByCell.get(definition.id);
    assert.equal(jobs.length, 10);
    assert.ok(jobs.every((job) => job.config.maxToolCalls === definition.maxToolCalls));
    assert.ok(jobs.every((job) => job.condition === definition.condition));
    for (const job of jobs) {
      const key = `${job.taskId}:${job.repeat}`;
      if (seedMap.has(key)) assert.equal(job.seed, seedMap.get(key));
      seedMap.set(key, job.seed);
      if (definition.plannerMode === "override_all") {
        assert.equal(stableStringify(job.initialGrantOverride), stableStringify(job.task.inferredCatalog));
      } else {
        assert.equal(job.initialGrantOverride, null);
      }
    }
  }
});

test("summary keeps exclusions out and reports the preregistered paired directions", async () => {
  const suite = await loadEntropySuite();
  const plan = await buildEntropyPlan({
    suite,
    repeats: 1,
    seed: "entropy-summary-test",
    runId: "entropy-summary-test",
    model: "scripted-entropy",
    apiBase: "local://entropy",
    providerProtocol: "scripted",
    maxRetries: 0,
    implementationIdentity: captureImplementationIdentity({ allowDirty: true }),
  });
  const resultsByCell = new Map();
  for (const definition of CELL_DEFINITIONS) {
    const results = plan.jobsByCell.get(definition.id).map((job, index) => {
      const hardPass = !new Set(["SHARDED_ALL_24", "SHARDED_PLANNER_24"]).has(definition.id);
      return fakeResult(job, definition, { hardPass, toolCalls: hardPass ? 3 : 25, index });
    });
    if (definition.id === "SHARDED_PLANNER_24") {
      results[0] = { ...results[0], status: "provider_error", verification: { semanticPass: null, policyPass: null, hardPass: null } };
    }
    resultsByCell.set(definition.id, results);
  }
  const summary = summarizeEntropyFrontier({ ...plan, resultsByCell });
  assert.equal(summary.observedResultCount, 25);
  assert.equal(summary.cells.find((cell) => cell.cellId === "ROOT_HANDLE_24").hardPassRate, 1);
  assert.equal(summary.cells.find((cell) => cell.cellId === "SHARDED_ALL_24").hardPassRate, 0);
  assert.equal(summary.cells.find((cell) => cell.cellId === "SHARDED_PLANNER_24").excluded, 1);
  assert.equal(summary.contrasts.find((contrast) => contrast.id === "root_vs_sharded_24").hardPassDifference, 1);
  assert.equal(summary.contrasts.find((contrast) => contrast.id === "budget_40_vs_24").meanToolCallDifference, -22);
  assert.match(renderEntropyReport(summary), /Exploratory high-entropy interface diagnostic/);
});

function fakeResult(job, definition, { hardPass, toolCalls, index }) {
  const selected = definition.plannerMode === "oracle" ? job.task.oracleGrants : job.initialGrantOverride ?? [job.task.inferredCatalog[0]];
  return {
    jobId: job.jobId,
    runId: `run-${definition.id}-${index}`,
    status: "completed",
    verification: { semanticPass: hardPass, policyPass: true, hardPass },
    canary: { modelVisible: false, exfiltrated: false },
    attempts: [{ toolCalls }],
    usage: { totalTokens: hardPass ? 1_000 : 2_000 },
    durationMs: hardPass ? 1_000 : 2_000,
    surface: { grantFiles: selected.length, actualReadFiles: hardPass ? 2 : 16 },
    grants: { initial: selected },
    grantPlanning: definition.plannerMode === "oracle" ? null : {
      source: definition.plannerMode === "model" ? "model_planner" : "manifest_override",
      selectedGrants: selected,
      repairCount: 0,
    },
  };
}
