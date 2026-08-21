import assert from "node:assert/strict";
import test from "node:test";

import { CONDITIONS, DEFAULT_STAGE_BUDGET, STAGES } from "./protocol.mjs";
import {
  CHILD_TRANSCRIPT_SENTINEL,
  FakeSeniorEnvironment,
  FakeSeniorModel,
  SCRIPTED_PATCH_SENTINEL,
  runScriptedSmoke,
} from "./scripted-smoke.mjs";
import { runScriptedCondition } from "./scripted-harness.mjs";

test("three arms run the same four skills with the same immutable stage budget", async () => {
  const smoke = await runScriptedSmoke();
  assert.equal(smoke.ok, true);
  assert.equal(smoke.model.calls.length, CONDITIONS.length * STAGES.length);
  for (const condition of CONDITIONS) {
    const calls = smoke.model.calls.filter((call) => call.condition === condition);
    assert.deepEqual(calls.map((call) => call.stage), STAGES);
    assert.deepEqual(calls.map((call) => call.ordinal), [1, 2, 3, 4]);
    assert.equal(calls.every((call) => JSON.stringify(call.budget) === JSON.stringify(DEFAULT_STAGE_BUDGET)), true);
  }
  assert.equal(smoke.environment.workspaceEvents.filter((event) => event.event === "started").length, 12);
  assert.equal(smoke.environment.workspaceEvents.filter((event) => event.event === "disposed").length, 12);
  assert.equal(smoke.environment.activeWorkspaces.size, 0);
});

test("flat reuses one disposable scope while composed creates and destroys four fresh stage children", async () => {
  const smoke = await runScriptedSmoke();
  const byCondition = Object.fromEntries(smoke.result.runs.map((run) => [run.condition, run]));
  assert.equal(byCondition.INLINE_PERSISTENT.lifecycle.scopesStarted, 0);

  const flat = byCondition.FLAT_DISPOSABLE;
  assert.equal(flat.lifecycle.scopesStarted, 1);
  assert.equal(flat.lifecycle.scopesDisposed, 1);
  assert.equal(new Set(flat.telemetry.stages.map((row) => row.scope.scopeId)).size, 1);

  const composed = byCondition.COMPOSED_DISPOSABLE;
  assert.equal(composed.lifecycle.scopesStarted, 5, "one coordinator plus four stage children");
  assert.equal(composed.lifecycle.scopesDisposed, 5);
  const coordinator = composed.lifecycle.scopes.find((scope) => scope.kind === "coordinator");
  const children = composed.lifecycle.scopes.filter((scope) => scope.kind === "stage-child");
  assert.equal(children.length, 4);
  assert.equal(new Set(children.map((scope) => scope.scopeId)).size, 4);
  assert.equal(children.every((scope) => scope.parentScopeId === coordinator.scopeId), true);
  assert.equal(children.every((scope) => scope.rootScopeId === coordinator.scopeId), true);
  assert.equal(children.every((scope) => scope.status === "disposed"), true);
  assert.equal(smoke.environment.activeScopes.size, 0);
});

test("patch bodies and child transcripts stay behind structured artifact handles", async () => {
  const smoke = await runScriptedSmoke();
  const parentText = JSON.stringify(smoke.result.runs.map((run) => run.parentProjection));
  assert.equal(parentText.includes(SCRIPTED_PATCH_SENTINEL), false);
  assert.equal(parentText.includes("diff --git"), false);
  assert.equal(parentText.includes(CHILD_TRANSCRIPT_SENTINEL), false);
  for (const run of smoke.result.runs) {
    assert.match(run.parentProjection.finalArtifact.artifactRef, /^artifact:\/\/sha256\/[a-f0-9]{64}$/u);
    assert.match(run.parentProjection.finalArtifact.sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.equal("content" in run.parentProjection.finalArtifact, false);
    assert.equal(smoke.artifactStore.read(run.parentProjection.finalArtifact.artifactRef).includes(SCRIPTED_PATCH_SENTINEL), true);
  }
  assert.equal(new Set(smoke.result.runs.map((run) => run.parentProjection.finalArtifact.artifactRef)).size, 1);
});

test("per-stage telemetry exposes parent and active-provider context without child-history leakage", async () => {
  const smoke = await runScriptedSmoke();
  const byCondition = Object.fromEntries(smoke.result.runs.map((run) => [run.condition, run]));
  for (const run of smoke.result.runs) {
    assert.deepEqual(run.telemetry.stages.map((row) => row.stage), STAGES);
    for (const row of run.telemetry.stages) {
      for (const measurement of Object.values(row.context)) {
        assert.equal(Number.isSafeInteger(measurement.bytes), true);
        assert.equal(Number.isSafeInteger(measurement.estimatedTokens), true);
        assert.equal(Number.isSafeInteger(measurement.messageCount), true);
      }
      assert.ok(row.context.providerAfterResult.bytes > row.context.providerAtCall.bytes);
    }
  }
  const inlineParentEnds = byCondition.INLINE_PERSISTENT.telemetry.stages.map((row) => row.context.parentAtEnd.bytes);
  assert.equal(inlineParentEnds.every((bytes, index) => index === 0 || bytes > inlineParentEnds[index - 1]), true);
  const flatProviderCalls = byCondition.FLAT_DISPOSABLE.telemetry.stages.map((row) => row.context.providerAtCall.bytes);
  assert.equal(flatProviderCalls.every((bytes, index) => index === 0 || bytes > flatProviderCalls[index - 1]), true);
  const composedProviderCalls = byCondition.COMPOSED_DISPOSABLE.telemetry.stages.map((row) => row.context.providerAtCall.bytes);
  assert.ok(composedProviderCalls.at(-1) < flatProviderCalls.at(-1), "fresh children should not inherit prior working transcripts");
  assert.ok(byCondition.INLINE_PERSISTENT.telemetry.parentContextAucBytes > byCondition.COMPOSED_DISPOSABLE.telemetry.parentContextAucBytes);
});

test("composed failure still disposes the failing child, coordinator, and stage workspace", async () => {
  const environment = new FakeSeniorEnvironment();
  const model = new FakeSeniorModel({ failAt: { condition: "COMPOSED_DISPOSABLE", stage: "review" } });
  await assert.rejects(() => runScriptedCondition({
    task: { id: "failure-cleanup", repo: "example/upstream", baseCommit: "abc", problemStatement: "exercise cleanup" },
    condition: "COMPOSED_DISPOSABLE",
    environment,
    model,
  }), /scripted model failure/u);
  assert.equal(environment.activeScopes.size, 0);
  assert.equal(environment.activeWorkspaces.size, 0);
  assert.equal(environment.scopeEvents.filter((event) => event.event === "started").length, 4);
  assert.equal(environment.scopeEvents.filter((event) => event.event === "disposed").length, 4);
});

