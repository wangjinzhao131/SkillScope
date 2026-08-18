import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureImplementationIdentity } from "../src/implementation-identity.mjs";
import { readJsonLines } from "../src/jsonl.mjs";
import { loadEntropySuite } from "./executor.mjs";
import {
  buildPlannerProbePlan,
  runPlannerProbe,
  summarizePlannerProbe,
} from "./planner-budget-probe.mjs";

test("planner probe freezes 60 paired catalog-width by output-budget trials", async () => {
  const suite = await loadEntropySuite();
  const descriptor = await buildPlannerProbePlan({
    suite,
    repeats: 2,
    seed: "planner-probe-test",
    model: "scripted-planner",
    apiBase: "local://planner",
    providerProtocol: "scripted",
    implementationIdentity: captureImplementationIdentity({ allowDirty: true }),
  });
  assert.equal(descriptor.trials.length, 60);
  assert.equal(new Set(descriptor.trials.map((trial) => trial.trialId)).size, 60);
  const seeds = new Map();
  for (const trial of descriptor.trials) {
    const key = `${trial.taskId}:${trial.repeat}`;
    if (seeds.has(key)) assert.equal(trial.seed, seeds.get(key));
    seeds.set(key, trial.seed);
  }
});

test("scripted probe distinguishes token-exhaustion protocol failure from valid but uncovered selection", async () => {
  const suite = await loadEntropySuite();
  const client = new BudgetSensitivePlannerClient();
  const descriptor = await buildPlannerProbePlan({
    suite,
    repeats: 1,
    seed: "planner-probe-scripted",
    model: client.model,
    apiBase: client.apiBase,
    providerProtocol: "scripted",
    implementationIdentity: captureImplementationIdentity({ allowDirty: true }),
  });
  const temporary = await mkdtemp(join(tmpdir(), "skillscope-planner-probe-"));
  const resultsPath = join(temporary, "results.jsonl");
  const run = await runPlannerProbe({ descriptor, suite, client, resultsPath, concurrency: 6 });
  assert.equal(run.executed, 30);
  const summary = summarizePlannerProbe({ descriptor, results: await readJsonLines(resultsPath) });
  for (const mode of ["root", "sharded"]) {
    const low = summary.cells.find((cell) => cell.catalogMode === mode && cell.plannerMaxTokens === 512);
    assert.equal(low.validPlanCount, 0);
    assert.equal(low.fallbackAllCount, 5);
    assert.deepEqual(low.finishReasonCounts, { length: 10 });
    const high = summary.cells.find((cell) => cell.catalogMode === mode && cell.plannerMaxTokens === 1_024);
    assert.equal(high.validPlanCount, 5);
    assert.equal(high.firstAttemptValidCount, 5);
  }
  assert.equal(summary.cells.find((cell) => cell.catalogMode === "root" && cell.plannerMaxTokens === 1_024).coverageCount, 5);
  assert.equal(summary.cells.find((cell) => cell.catalogMode === "sharded" && cell.plannerMaxTokens === 1_024).coverageCount, 0);
});

class BudgetSensitivePlannerClient {
  constructor() {
    this.model = "scripted-planner";
    this.apiBase = "local://planner";
    this.apiKey = "scripted-placeholder";
    this.counter = 0;
  }

  publicConfig() {
    return { model: this.model, apiBase: this.apiBase, protocol: "scripted", timeoutMs: 1_000, maxRetries: 0 };
  }

  async complete({ maxTokens }) {
    this.counter += 1;
    if (maxTokens === 512) {
      return {
        message: { role: "assistant", content: "reasoning without a tool call" },
        finishReason: "length",
        usage: { promptTokens: 10, completionTokens: 512, totalTokens: 522, apiCalls: 1 },
        requestId: `scripted-${this.counter}`,
        providerModel: this.model,
      };
    }
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `scripted-${this.counter}`,
          type: "function",
          function: { name: "select_grants", arguments: JSON.stringify({ catalogIndexes: [0], reason: "Smallest visible catalog candidate" }) },
        }],
      },
      finishReason: "tool_calls",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, apiCalls: 1 },
      requestId: `scripted-${this.counter}`,
      providerModel: this.model,
    };
  }
}
