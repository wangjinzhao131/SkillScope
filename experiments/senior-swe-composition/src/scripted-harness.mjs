import { ContentAddressedArtifactStore, assertArtifactHandle } from "./artifact-store.mjs";
import {
  CONDITIONS,
  DEFAULT_STAGE_BUDGET,
  PROTOCOL_VERSION,
  STAGES,
  assertKnownCondition,
  normalizeStageBudget,
} from "./protocol.mjs";

const EMPTY_USAGE = Object.freeze({ turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 });

export async function runThreeArmScriptedExperiment({
  task,
  environment,
  model,
  artifactStore = new ContentAddressedArtifactStore(),
  stageBudget = DEFAULT_STAGE_BUDGET,
} = {}) {
  validateDependencies(task, environment, model, artifactStore);
  const budget = normalizeStageBudget(stageBudget);
  const runs = [];
  for (const condition of CONDITIONS) {
    runs.push(await runScriptedCondition({ task, condition, environment, model, artifactStore, stageBudget: budget }));
  }
  return { protocolVersion: PROTOCOL_VERSION, taskId: task.id, stageBudget: budget, runs };
}

export async function runScriptedCondition({
  task,
  condition,
  environment,
  model,
  artifactStore = new ContentAddressedArtifactStore(),
  stageBudget = DEFAULT_STAGE_BUDGET,
} = {}) {
  validateDependencies(task, environment, model, artifactStore);
  assertKnownCondition(condition);
  const budget = normalizeStageBudget(stageBudget);
  const parentSessionId = environment.createParentSessionId({ taskId: task.id, condition });
  const parentContext = new ContextLedger([
    message("system", "parent-system", "Run the fixed investigate/implement/review/repair workflow."),
    message("user", "task", publicTaskText(task)),
  ]);
  const stageResults = [];
  const stageTelemetry = [];
  const scopeTrace = [];
  let currentArtifact;
  let finalProjection;
  let verification;

  const execute = async ({ stage, scope, providerContext }) => {
    const ordinal = STAGES.indexOf(stage) + 1;
    const parentAtStart = parentContext.measure();
    const priorResult = stageResults.at(-1);
    const stageInput = compactStageInput({ stage, ordinal, priorResult, currentArtifact });
    providerContext.append(message("user", "stage-request", JSON.stringify(stageInput)));
    const providerAtCall = providerContext.measure();
    const workspace = await environment.prepareStage({
      task: publicTask(task),
      condition,
      stage,
      ordinal,
      scope,
      inputArtifact: currentArtifact,
      resolveArtifact: (artifactRef) => artifactStore.read(artifactRef),
    });
    let raw;
    try {
      raw = await model.executeStage({
        task: publicTask(task),
        condition,
        stage,
        ordinal,
        scope: structuredClone(scope),
        workspace: publicWorkspace(workspace),
        budget: structuredClone(budget),
        input: stageInput,
        providerContext: providerContext.snapshot(),
      });
    } finally {
      await environment.disposeStage(workspace.workspaceId);
    }
    const candidate = validateModelResult(raw, budget, stage);
    if (candidate.patch !== undefined) currentArtifact = artifactStore.put(candidate.patch);
    const projected = projectStageResult(candidate, stage, ordinal, currentArtifact);
    stageResults.push(projected);
    providerContext.append(message("assistant", "working-transcript", candidate.workingTranscript));
    providerContext.append(message("assistant", "stage-result", JSON.stringify(projected)));

    if (condition === "INLINE_PERSISTENT") {
      // The provider context is the parent context, so its complete working history persists.
    } else if (stage === STAGES.at(-1)) {
      verification = await verifyFinalArtifact({ environment, task, condition, currentArtifact, artifactStore });
      finalProjection = createParentProjection({ task, condition, stageResults, currentArtifact, verification });
      parentContext.append(message("assistant", "structured-result", JSON.stringify(finalProjection)));
    }
    const providerAfterResult = providerContext.measure();
    stageTelemetry.push({
      stage,
      ordinal,
      scope: structuredClone(scope),
      budget: structuredClone(budget),
      usage: candidate.usage,
      context: {
        parentAtStart,
        providerAtCall,
        providerAfterResult,
        parentAtEnd: parentContext.measure(),
      },
    });
    return projected;
  };

  if (condition === "INLINE_PERSISTENT") {
    const parentScope = Object.freeze({
      scopeId: parentSessionId,
      parentScopeId: null,
      rootScopeId: parentSessionId,
      kind: "parent-session",
    });
    for (const stage of STAGES) await execute({ stage, scope: parentScope, providerContext: parentContext });
    verification = await verifyFinalArtifact({ environment, task, condition, currentArtifact, artifactStore });
    finalProjection = createParentProjection({ task, condition, stageResults, currentArtifact, verification });
    parentContext.append(message("assistant", "structured-result", JSON.stringify(finalProjection)));
  } else if (condition === "FLAT_DISPOSABLE") {
    parentContext.append(message("assistant", "scope-invocation", "Invoke one disposable worker for all four fixed stages."));
    const flatScope = await openScope(environment, scopeTrace, {
      taskId: task.id,
      condition,
      kind: "flat-worker",
      parentScopeId: parentSessionId,
      rootScopeId: null,
    });
    const workerContext = new ContextLedger([
      message("system", "worker-system", "Disposable flat worker. Run all four fixed stages."),
      message("user", "task", publicTaskText(task)),
    ]);
    try {
      for (const stage of STAGES) await execute({ stage, scope: flatScope, providerContext: workerContext });
    } finally {
      await closeScope(environment, scopeTrace, flatScope.scopeId);
    }
  } else {
    parentContext.append(message("assistant", "scope-invocation", "Invoke a disposable coordinator with one fresh child per stage."));
    const coordinator = await openScope(environment, scopeTrace, {
      taskId: task.id,
      condition,
      kind: "coordinator",
      parentScopeId: parentSessionId,
      rootScopeId: null,
    });
    try {
      for (const stage of STAGES) {
        const child = await openScope(environment, scopeTrace, {
          taskId: task.id,
          condition,
          stage,
          kind: "stage-child",
          parentScopeId: coordinator.scopeId,
          rootScopeId: coordinator.rootScopeId,
        });
        const childContext = new ContextLedger([
          message("system", "child-system", `Fresh disposable ${stage} skill.`),
          message("user", "task", publicTaskText(task)),
        ]);
        try {
          await execute({ stage, scope: child, providerContext: childContext });
        } finally {
          await closeScope(environment, scopeTrace, child.scopeId);
        }
      }
    } finally {
      await closeScope(environment, scopeTrace, coordinator.scopeId);
    }
  }

  if (!finalProjection) throw new Error(`${condition} did not produce a parent projection`);
  return {
    schemaVersion: "senior-swe-composition.scripted-result.v1",
    protocolVersion: PROTOCOL_VERSION,
    taskId: task.id,
    condition,
    status: verification?.passed ? "completed" : "capability_failure",
    stageBudget: budget,
    stages: stageResults,
    parentProjection: finalProjection,
    telemetry: {
      stages: stageTelemetry,
      parentFinal: parentContext.measure(),
      parentContextAucBytes: stageTelemetry.reduce((total, row) => total + row.context.parentAtEnd.bytes, 0),
    },
    lifecycle: {
      parentSessionId,
      scopes: scopeTrace,
      scopesStarted: scopeTrace.length,
      scopesDisposed: scopeTrace.filter((scope) => scope.status === "disposed").length,
      valid: scopeTrace.every((scope) => scope.status === "disposed"),
    },
  };
}

class ContextLedger {
  #messages;

  constructor(initial = []) {
    this.#messages = initial.map((entry) => structuredClone(entry));
  }

  append(entry) {
    this.#messages.push(structuredClone(entry));
  }

  snapshot() {
    return structuredClone(this.#messages);
  }

  measure() {
    const bytes = Buffer.byteLength(JSON.stringify(this.#messages), "utf8");
    return Object.freeze({ messageCount: this.#messages.length, bytes, estimatedTokens: Math.ceil(bytes / 4) });
  }
}

async function openScope(environment, trace, request) {
  const opened = await environment.openScope(structuredClone(request));
  if (!opened || typeof opened.scopeId !== "string" || opened.scopeId.length === 0) throw new Error("environment returned an invalid scopeId");
  const rootScopeId = request.rootScopeId ?? opened.scopeId;
  const scope = Object.freeze({
    scopeId: opened.scopeId,
    parentScopeId: request.parentScopeId,
    rootScopeId,
    kind: request.kind,
  });
  trace.push({ ...scope, status: "started" });
  return scope;
}

async function closeScope(environment, trace, scopeId) {
  await environment.disposeScope(scopeId);
  const record = trace.findLast((candidate) => candidate.scopeId === scopeId);
  if (!record || record.status !== "started") throw new Error(`scope ${scopeId} cannot be disposed`);
  record.status = "disposed";
}

async function verifyFinalArtifact({ environment, task, condition, currentArtifact, artifactStore }) {
  if (!currentArtifact) return { passed: false, code: "NO_FINAL_ARTIFACT" };
  assertArtifactHandle(currentArtifact);
  const raw = await environment.verify({
    task: publicTask(task),
    condition,
    artifact: structuredClone(currentArtifact),
    resolveArtifact: (artifactRef) => artifactStore.read(artifactRef),
  });
  if (!raw || typeof raw.passed !== "boolean") throw new Error("environment verifier returned an invalid result");
  return deepDataOnly(raw, "verification");
}

function validateModelResult(raw, budget, stage) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${stage} returned no structured result`);
  if (typeof raw.summary !== "string" || raw.summary.length === 0) throw new Error(`${stage} returned no summary`);
  if (!Array.isArray(raw.evidence) || raw.evidence.some((entry) => typeof entry !== "string")) throw new Error(`${stage} returned invalid evidence`);
  if (typeof raw.workingTranscript !== "string") throw new Error(`${stage} returned no working transcript`);
  if (raw.patch !== undefined && (typeof raw.patch !== "string" || raw.patch.length === 0)) throw new Error(`${stage} returned an invalid patch`);
  const usage = { ...EMPTY_USAGE, ...raw.usage };
  for (const name of Object.keys(EMPTY_USAGE)) {
    if (!Number.isSafeInteger(usage[name]) || usage[name] < 0) throw new Error(`${stage} returned invalid usage.${name}`);
  }
  if (usage.turns > budget.maxTurns) throw new Error(`${stage} exceeded maxTurns`);
  if (usage.toolCalls > budget.maxToolCalls) throw new Error(`${stage} exceeded maxToolCalls`);
  const projectedBytes = Buffer.byteLength(JSON.stringify({ summary: raw.summary, evidence: raw.evidence }), "utf8");
  if (projectedBytes > budget.maxResultBytes) throw new Error(`${stage} exceeded maxResultBytes`);
  return {
    summary: raw.summary,
    evidence: [...raw.evidence],
    workingTranscript: raw.workingTranscript,
    patch: raw.patch,
    usage: Object.freeze(usage),
  };
}

function projectStageResult(candidate, stage, ordinal, currentArtifact) {
  return Object.freeze({
    stage,
    ordinal,
    status: "completed",
    summary: candidate.summary,
    evidence: Object.freeze([...candidate.evidence]),
    artifact: currentArtifact ? structuredClone(currentArtifact) : null,
  });
}

function compactStageInput({ stage, ordinal, priorResult, currentArtifact }) {
  return Object.freeze({
    stage,
    ordinal,
    priorResult: priorResult ? structuredClone(priorResult) : null,
    inputArtifact: currentArtifact ? structuredClone(currentArtifact) : null,
  });
}

function createParentProjection({ task, condition, stageResults, currentArtifact, verification }) {
  return Object.freeze({
    schemaVersion: "senior-swe-composition.parent-projection.v1",
    taskId: task.id,
    condition,
    status: verification.passed ? "completed" : "capability_failure",
    stages: stageResults.map(({ stage, status, summary, evidence, artifact }) => ({ stage, status, summary, evidence, artifact })),
    finalArtifact: currentArtifact ? structuredClone(currentArtifact) : null,
    verification: structuredClone(verification),
  });
}

function validateDependencies(task, environment, model, artifactStore) {
  if (!task || typeof task.id !== "string" || task.id.length === 0 || typeof task.problemStatement !== "string") {
    throw new Error("task must include id and problemStatement");
  }
  for (const name of ["createParentSessionId", "openScope", "disposeScope", "prepareStage", "disposeStage", "verify"]) {
    if (typeof environment?.[name] !== "function") throw new Error(`environment.${name} is required`);
  }
  if (typeof model?.executeStage !== "function") throw new Error("model.executeStage is required");
  if (typeof artifactStore?.put !== "function" || typeof artifactStore?.read !== "function") throw new Error("artifactStore is invalid");
}

function publicTask(task) {
  return deepDataOnly({ id: task.id, repo: task.repo, baseCommit: task.baseCommit, problemStatement: task.problemStatement }, "task");
}

function publicTaskText(task) {
  return JSON.stringify(publicTask(task));
}

function publicWorkspace(workspace) {
  if (!workspace || typeof workspace.workspaceId !== "string") throw new Error("environment returned an invalid workspace");
  return deepDataOnly({ workspaceId: workspace.workspaceId, baseCommit: workspace.baseCommit }, "workspace");
}

function message(role, kind, content) {
  return Object.freeze({ role, kind, content });
}

function deepDataOnly(value, label) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${label} is not serializable`);
  return JSON.parse(encoded);
}

