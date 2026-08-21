import { pathToFileURL } from "node:url";
import { ContentAddressedArtifactStore } from "./artifact-store.mjs";
import { CONDITIONS, STAGES } from "./protocol.mjs";
import { runThreeArmScriptedExperiment } from "./scripted-harness.mjs";

export const SCRIPTED_PATCH_SENTINEL = "PATCH_BODY_MUST_STAY_BEHIND_ARTIFACT_HANDLE";
export const CHILD_TRANSCRIPT_SENTINEL = "CHILD_WORKING_TRANSCRIPT_MUST_NOT_REACH_PARENT_PROJECTION";

export class FakeSeniorEnvironment {
  constructor() {
    this.parentCursor = 0;
    this.scopeCursor = 0;
    this.workspaceCursor = 0;
    this.scopeEvents = [];
    this.workspaceEvents = [];
    this.verifications = [];
    this.activeScopes = new Set();
    this.activeWorkspaces = new Set();
  }

  createParentSessionId({ taskId, condition }) {
    this.parentCursor += 1;
    return `parent-${this.parentCursor}-${condition.toLowerCase()}-${taskId}`;
  }

  async openScope(request) {
    const scopeId = `scope-${++this.scopeCursor}`;
    if (this.activeScopes.has(scopeId)) throw new Error(`duplicate scope ${scopeId}`);
    this.activeScopes.add(scopeId);
    this.scopeEvents.push({ event: "started", scopeId, ...structuredClone(request) });
    return { scopeId };
  }

  async disposeScope(scopeId) {
    if (!this.activeScopes.delete(scopeId)) throw new Error(`cannot dispose inactive scope ${scopeId}`);
    this.scopeEvents.push({ event: "disposed", scopeId });
  }

  async prepareStage({ task, condition, stage, ordinal, scope, inputArtifact, resolveArtifact }) {
    const workspaceId = `workspace-${++this.workspaceCursor}`;
    this.activeWorkspaces.add(workspaceId);
    if (inputArtifact) resolveArtifact(inputArtifact.artifactRef);
    this.workspaceEvents.push({
      event: "started",
      workspaceId,
      taskId: task.id,
      condition,
      stage,
      ordinal,
      scopeId: scope.scopeId,
      inputArtifact: inputArtifact ? structuredClone(inputArtifact) : null,
    });
    return { workspaceId, baseCommit: task.baseCommit };
  }

  async disposeStage(workspaceId) {
    if (!this.activeWorkspaces.delete(workspaceId)) throw new Error(`cannot dispose inactive workspace ${workspaceId}`);
    this.workspaceEvents.push({ event: "disposed", workspaceId });
  }

  async verify({ task, condition, artifact, resolveArtifact }) {
    const body = resolveArtifact(artifact.artifactRef);
    const result = {
      passed: body.includes(SCRIPTED_PATCH_SENTINEL) && body.includes("repair"),
      code: "FAKE_NATIVE_VERIFIER",
      checksPassed: body.includes("repair") ? 1 : 0,
      checksTotal: 1,
    };
    this.verifications.push({ taskId: task.id, condition, artifact: structuredClone(artifact), ...result });
    return result;
  }
}

export class FakeSeniorModel {
  constructor({ failAt } = {}) {
    this.calls = [];
    this.failAt = failAt;
  }

  async executeStage(request) {
    this.calls.push(structuredClone(request));
    if (this.failAt?.condition === request.condition && this.failAt?.stage === request.stage) {
      throw new Error(`scripted model failure at ${request.condition}/${request.stage}`);
    }
    const patch = request.stage === "implement" || request.stage === "repair"
      ? [
        "diff --git a/example.js b/example.js",
        "--- a/example.js",
        "+++ b/example.js",
        `+${SCRIPTED_PATCH_SENTINEL}:${request.stage}`,
      ].join("\n")
      : undefined;
    return {
      summary: `${request.stage} completed for ${request.task.id}`,
      evidence: [`${request.task.repo}:example.js:${request.ordinal}`],
      workingTranscript: `${CHILD_TRANSCRIPT_SENTINEL}:${request.stage}:`.repeat(96),
      patch,
      usage: { turns: 2, toolCalls: 3, inputTokens: 120 + request.ordinal, outputTokens: 40 + request.ordinal },
    };
  }
}

export async function runScriptedSmoke(options = {}) {
  const environment = options.environment ?? new FakeSeniorEnvironment();
  const model = options.model ?? new FakeSeniorModel();
  const artifactStore = options.artifactStore ?? new ContentAddressedArtifactStore();
  const task = options.task ?? {
    id: "scripted-real-task-shape",
    repo: "example/upstream",
    baseCommit: "0123456789abcdef",
    problemStatement: "A real issue statement would be injected here without oracle material.",
  };
  const result = await runThreeArmScriptedExperiment({ task, environment, model, artifactStore });
  const serializedParents = JSON.stringify(result.runs.map((run) => run.parentProjection));
  const checks = {
    allConditions: result.runs.length === CONDITIONS.length,
    fixedStages: result.runs.every((run) => JSON.stringify(run.stages.map((stage) => stage.stage)) === JSON.stringify(STAGES)),
    lifecycleClosed: environment.activeScopes.size === 0 && environment.activeWorkspaces.size === 0,
    noPatchBodyInParentProjection: !serializedParents.includes(SCRIPTED_PATCH_SENTINEL) && !serializedParents.includes("diff --git"),
    noChildTranscriptInParentProjection: !serializedParents.includes(CHILD_TRANSCRIPT_SENTINEL),
    allVerified: result.runs.every((run) => run.status === "completed"),
  };
  return { ok: Object.values(checks).every(Boolean), checks, result, environment, model, artifactStore };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const smoke = await runScriptedSmoke();
  const output = {
    ok: smoke.ok,
    checks: smoke.checks,
    runs: smoke.result.runs.map((run) => ({
      condition: run.condition,
      status: run.status,
      stages: run.stages.map((stage) => stage.stage),
      scopesStarted: run.lifecycle.scopesStarted,
      scopesDisposed: run.lifecycle.scopesDisposed,
      parentFinalBytes: run.telemetry.parentFinal.bytes,
    })),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

