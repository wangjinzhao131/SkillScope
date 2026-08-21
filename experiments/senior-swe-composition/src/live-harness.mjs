import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  convertToLlm,
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  estimateTokens,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DockerTaskRuntime, runNativeVerifier } from "./docker-task.mjs";
import { ARMS, STAGES } from "./protocol.mjs";

export const LIVE_MODEL = Object.freeze({
  provider: "opencode-go",
  id: "deepseek-v4-flash",
  api: "openai-completions",
  baseUrl: "https://opencode.ai/zen/go/v1",
});

const EMPTY_USAGE = Object.freeze({
  apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, totalTokens: 0, cost: 0,
});

export async function createSeniorLiveEnvironment(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("EXPERIMENT_KEY is required in memory");
  const credentials = new EphemeralCredentialStore();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const catalogModel = modelRuntime.getModel(LIVE_MODEL.provider, LIVE_MODEL.id);
  if (!catalogModel) throw new Error(`${LIVE_MODEL.provider}/${LIVE_MODEL.id} is absent from the Pi catalog`);
  if (catalogModel.api !== LIVE_MODEL.api || catalogModel.baseUrl !== LIVE_MODEL.baseUrl) {
    throw new Error(`model identity mismatch: ${catalogModel.api} ${catalogModel.baseUrl}`);
  }
  await modelRuntime.setRuntimeApiKey(LIVE_MODEL.provider, apiKey);
  await modelRuntime.refresh({ providers: [LIVE_MODEL.provider], allowNetwork: false });
  return {
    apiKey,
    modelRuntime,
    modelRegistry: new ModelRegistry(modelRuntime),
    catalogModel,
    async dispose() { await modelRuntime.removeRuntimeApiKey(LIVE_MODEL.provider).catch(() => {}); },
  };
}

export async function runSeniorLiveJob(job, environment) {
  assertJob(job);
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "skillscope-senior-live-"));
  const artifactRoot = job.artifactRoot ?? join(temporaryRoot, "artifacts");
  const docker = new DockerTaskRuntime({
    image: job.image,
    repoPath: job.repoPath,
    artifactRoot,
    cpus: job.resources?.cpus ?? 4,
    memory: job.resources?.memory ?? "8g",
  });
  const sessions = [];
  const stageResults = [];
  const contextTraces = [];
  const scopes = [];
  const sentinels = [];
  let finalPatch;
  let nativeVerifier;
  let failure;
  let persistent;
  const deadline = Date.now() + (job.timeoutMs ?? 45 * 60_000);

  try {
    if (job.arm !== ARMS.COMPOSED) {
      persistent = await createWorkerSession({
        environment,
        model: modelForJob(environment.catalogModel, job.seed),
        docker,
        label: job.arm === ARMS.INLINE ? "inline-root" : "flat-worker",
        contextTraces,
      });
      sessions.push(persistent);
      if (job.arm === ARMS.FLAT) scopes.push(scopeStart("flat-worker", 0));
    } else {
      scopes.push(scopeStart("composed-main", 0));
    }

    for (const stageName of STAGES) {
      const priorPatch = stageName === "review" || stageName === "repair" ? finalPatch?.path : undefined;
      const workspace = await docker.createStage({ inputPatchPath: priorPatch });
      const leafScope = job.arm === ARMS.COMPOSED ? scopeStart(`${stageName}-leaf`, 1) : null;
      sentinels.push(workspace.sentinel);
      if (leafScope) {
        leafScope.sentinelHash = hash(workspace.sentinel);
        scopes.push(leafScope);
      }
      let worker = persistent;
      try {
        if (!worker) {
          worker = await createWorkerSession({
            environment,
            model: modelForJob(environment.catalogModel, job.seed),
            docker,
            label: `${stageName}-leaf`,
            sentinel: workspace.sentinel,
            contextTraces,
          });
          sessions.push(worker);
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw codedError("TASK_ARM_TIMEOUT", "task-arm wall-clock budget exhausted");
        const stageResult = await worker.runStage({
          stageName,
          workspace,
          instruction: job.instruction,
          priorResults: structuredClone(stageResults),
          timeoutMs: remainingMs,
        });
        if (["implement", "repair"].includes(stageName)) {
          const patch = await docker.exportPatch(workspace.containerId, `${job.taskId}-${job.arm}-${stageName}`);
          if (patch.artifactBytes === 0) throw codedError("EMPTY_PATCH", `${stageName} produced an empty patch`);
          Object.assign(stageResult, patchMetadata(patch));
          finalPatch = patch;
        }
        stageResults.push(stageResult);
        if (leafScope) scopeDispose(leafScope, "SUCCESS");
      } finally {
        await docker.disposeStage(workspace.containerId);
        if (!persistent && worker) {
          worker.dispose();
          if (leafScope && !leafScope.endedAt) scopeDispose(leafScope, "FAILED");
        }
      }
    }

    if (persistent) {
      persistent.dispose();
      persistent = null;
      if (job.arm === ARMS.FLAT) scopeDispose(scopes.find((scope) => scope.name === "flat-worker"), "SUCCESS");
    }
    if (job.arm === ARMS.COMPOSED) scopeDispose(scopes.find((scope) => scope.name === "composed-main"), "SUCCESS");
    const lifecycleBeforeVerifier = lifecycleProjection(job.arm, scopes, docker.lifecycle());
    if (!lifecycleBeforeVerifier.valid) throw codedError("LIFECYCLE_INVALID", "not every disposable scope/workspace was destroyed before verification");
    nativeVerifier = await runNativeVerifier({
      image: job.image,
      repoPath: job.repoPath,
      taskRoot: job.taskRoot,
      patchPath: finalPatch.path,
      timeoutMs: job.verifierTimeoutMs ?? 15 * 60_000,
    });
  } catch (error) {
    failure = sanitizeError(error, environment.apiKey);
  } finally {
    if (persistent) persistent.dispose();
    if (job.arm === ARMS.FLAT) scopeDispose(scopes.find((scope) => scope.name === "flat-worker"), failure ? "FAILED" : "SUCCESS");
    if (job.arm === ARMS.COMPOSED) scopeDispose(scopes.find((scope) => scope.name === "composed-main"), failure ? "FAILED" : "SUCCESS");
    await docker.dispose();
  }

  const sessionUsage = sessions.map((session) => session.usage());
  const usage = sumUsage(sessionUsage);
  const rootProjection = compactRootProjection(job, stageResults, finalPatch, failure);
  const rootEnvelope = { taskInstruction: job.instruction, result: rootProjection };
  const rootBytes = job.arm === ARMS.INLINE
    ? maxTrace(contextTraces.filter((trace) => trace.sessionLabel === "inline-root"), "messageBytes")
    : Buffer.byteLength(JSON.stringify(rootEnvelope));
  const coordinatorTraces = job.arm === ARMS.COMPOSED
    ? typedCoordinatorTrace(stageResults)
    : contextTraces.filter((trace) => trace.sessionLabel === (job.arm === ARMS.INLINE ? "inline-root" : "flat-worker"));
  const lifecycle = lifecycleProjection(job.arm, scopes, docker.lifecycle());
  const record = {
    schemaVersion: "skillscope.senior-swe.live-result.v1",
    taskId: job.taskId,
    arm: job.arm,
    seed: job.seed,
    model: LIVE_MODEL,
    status: !failure && nativeVerifier?.infrastructureValid ? "completed" : failure ? "capability_failure" : "infrastructure_failure",
    startedAt,
    endedAt: new Date().toISOString(),
    wallTimeMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
    stages: stageResults,
    finalArtifact: finalPatch ? patchMetadata(finalPatch) : null,
    nativeVerifier: nativeVerifier ?? null,
    context: {
      rootFinalBytes: rootBytes,
      rootContextAucBytes: job.arm === ARMS.INLINE ? sumTrace(contextTraces, "inline-root", "messageBytes") : rootBytes,
      coordinatorFinalBytes: maxTrace(coordinatorTraces, "messageBytes"),
      coordinatorContextAucBytes: coordinatorTraces.reduce((sum, trace) => sum + trace.messageBytes, 0),
      requestMetrics: contextTraces,
    },
    usage,
    lifecycle,
    leakage: {
      sentinelInRootProjection: sentinels.some((sentinel) => JSON.stringify(rootEnvelope).includes(sentinel)),
      rawTranscriptsPersisted: false,
    },
    failure,
  };
  const sanitized = deepRedact(record, [environment.apiKey]);
  if (JSON.stringify(sanitized).includes(environment.apiKey)) throw new Error("refusing to return a record containing EXPERIMENT_KEY");
  if (!job.keepArtifacts) await rm(temporaryRoot, { recursive: true, force: true });
  return sanitized;
}

async function createWorkerSession({ environment, model, docker, label, sentinel, contextTraces }) {
  const state = { stageName: null, workspace: null, completion: null, turnsAtStageStart: 0, stageToolCalls: 0 };
  const tools = createTools(state, docker);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } });
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    modelRuntime: environment.modelRuntime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    resourceLoader: createMinimalResourceLoader(label, sentinel),
    settingsManager,
    sessionManager: SessionManager.inMemory(process.cwd()),
  });
  let turns = 0;
  let disposed = false;
  let cachedUsage;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") {
      turns += 1;
      const visible = convertToLlm(session.messages);
      contextTraces.push({
        sessionLabel: label,
        stage: state.stageName,
        ordinal: turns,
        providerContextTokens: session.getContextUsage()?.tokens ?? null,
        estimatedTokens: session.messages.reduce((sum, message) => sum + estimateTokens(message), 0),
        messageBytes: Buffer.byteLength(JSON.stringify(visible)),
        toolResultBytes: visible.filter((message) => message.role === "toolResult")
          .reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message.content)), 0),
      });
      if (turns - state.turnsAtStageStart > 40) void session.abort();
    }
  });
  return {
    async runStage({ stageName, workspace, instruction, priorResults, timeoutMs }) {
      state.stageName = stageName;
      state.workspace = workspace;
      state.completion = null;
      state.turnsAtStageStart = turns;
      state.stageToolCalls = 0;
      const timer = setTimeout(() => void session.abort(), timeoutMs);
      let promptError;
      try { await session.prompt(stagePrompt({ stageName, instruction, priorResults }), { expandPromptTemplates: false }); }
      catch (error) { promptError = error; }
      finally { clearTimeout(timer); }
      if (promptError) throw codedError("MODEL_OR_SESSION_ERROR", promptError.message ?? String(promptError));
      if (!state.completion) throw codedError("MISSING_STAGE_COMPLETE", `${stageName} ended without Runtime-valid completion`);
      return structuredClone(state.completion);
    },
    usage() { return cachedUsage ?? usageFromStats(session.getSessionStats()); },
    dispose() {
      if (disposed) return;
      cachedUsage = usageFromStats(session.getSessionStats());
      disposed = true;
      unsubscribe();
      session.dispose();
    },
  };
}

function createTools(state, docker) {
  const execTool = defineTool({
    name: "container_exec",
    label: "Run command in isolated task container",
    description: "Run one shell command in the current stage's network-disabled repository container.",
    executionMode: "sequential",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 16_384 }),
      timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      consumeToolCall(state);
      const result = await docker.exec(state.workspace.containerId, params.command, { timeoutMs: (params.timeoutSec ?? 120) * 1000 });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { exitCode: result.exitCode, truncated: result.truncated } };
    },
  });
  const patchTool = defineTool({
    name: "container_apply_patch",
    label: "Apply unified diff in isolated task container",
    description: "Apply a unified diff to the current repository. Use paths relative to the repository root.",
    executionMode: "sequential",
    parameters: Type.Object({ patch: Type.String({ minLength: 1, maxLength: 512 * 1024 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      consumeToolCall(state);
      const result = await docker.applyPatchText(state.workspace.containerId, params.patch);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { exitCode: result.exitCode } };
    },
  });
  return [execTool, patchTool, ...completionTools(state)];
}

function completionTools(state) {
  const common = {
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 24 }),
  };
  return [
    completionTool(state, "investigate", Type.Object({
      ...common,
      hypotheses: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 12 }),
      reproduction: Type.String({ minLength: 1, maxLength: 3000 }),
      nextAction: Type.String({ minLength: 1, maxLength: 2000 }),
    }, { additionalProperties: false })),
    completionTool(state, "implement", Type.Object({
      ...common,
      changedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
    }, { additionalProperties: false })),
    completionTool(state, "review", Type.Object({
      ...common,
      decision: Type.Union([Type.Literal("pass"), Type.Literal("needs_repair")]),
      findings: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { maxItems: 20 }),
      testSummary: Type.String({ minLength: 1, maxLength: 3000 }),
    }, { additionalProperties: false })),
    completionTool(state, "repair", Type.Object({
      ...common,
      changedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
      resolvedFindings: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { maxItems: 20 }),
    }, { additionalProperties: false })),
  ];
}

function completionTool(state, stageName, parameters) {
  return defineTool({
    name: `${stageName}_complete`,
    label: `Complete ${stageName} stage`,
    description: `Submit the Runtime-validated structured result for the ${stageName} stage.`,
    executionMode: "sequential",
    parameters,
    async execute(_id, params) {
      consumeToolCall(state);
      if (state.stageName !== stageName) {
        return { content: [{ type: "text", text: `Wrong completion tool: current stage is ${state.stageName}.` }], details: { accepted: false } };
      }
      if (state.completion) {
        return { content: [{ type: "text", text: "A completion was already accepted." }], details: { accepted: false }, terminate: true };
      }
      state.completion = { stage: stageName, status: "SUCCESS", ...structuredClone(params) };
      return { content: [{ type: "text", text: `${stageName} result accepted.` }], details: { accepted: true }, terminate: true };
    },
  });
}

function stagePrompt({ stageName, instruction, priorResults }) {
  const role = {
    investigate: "Investigate the failure, locate relevant code, reproduce or gather evidence, and propose a concrete repair. Do not edit files.",
    implement: "Implement the diagnosis in the repository, run focused visible tests, and leave the working tree with the proposed fix.",
    review: "Review the applied implementation independently. Inspect the diff and run focused visible tests. Do not edit files; identify any remaining defect.",
    repair: "Repair all substantiated findings, run focused visible tests, and leave the working tree with the final merge-ready fix.",
  }[stageName];
  return [
    "You are executing one frozen atomic software-engineering Skill in the SkillScope experiment.",
    `STAGE: ${stageName}`,
    role,
    "Use only container_exec and container_apply_patch. The container has no network. Do not look for /tests, /solution, oracle patches, benchmark metadata, or hidden evaluators.",
    "When done, call the matching *_complete tool exactly once. Evidence refs should name commands or repo-relative files/lines you actually inspected.",
    "TASK INSTRUCTION:",
    instruction,
    "RUNTIME-VALIDATED PRIOR RESULTS:",
    JSON.stringify(priorResults),
  ].join("\n\n");
}

function compactRootProjection(job, stages, patch, failure) {
  return {
    taskId: job.taskId,
    status: failure ? "FAILED" : "SUCCESS",
    stageStatuses: stages.map((stage) => ({ stage: stage.stage, status: stage.status })),
    finalArtifactRef: patch?.artifactRef ?? null,
    finalArtifactHash: patch?.artifactHash ?? null,
    failureCode: failure?.code ?? null,
  };
}

function typedCoordinatorTrace(stages) {
  const visible = [];
  return stages.map((stage, index) => {
    visible.push(stage);
    const messageBytes = Buffer.byteLength(JSON.stringify(visible));
    return { sessionLabel: "composed-main", stage: stage.stage, ordinal: index + 1, providerContextTokens: null, estimatedTokens: Math.ceil(messageBytes / 4), messageBytes, toolResultBytes: messageBytes };
  });
}

function scopeStart(name, depth) {
  return { name, depth, startedAt: new Date().toISOString(), endedAt: null, status: "ACTIVE", sentinelHash: null };
}
function scopeDispose(scope, status) {
  if (!scope || scope.endedAt) return;
  scope.status = status;
  scope.endedAt = new Date().toISOString();
}
function lifecycleProjection(arm, scopes, dockerLifecycle) {
  const expected = arm === ARMS.INLINE ? 0 : arm === ARMS.FLAT ? 1 : 5;
  const started = scopes.length;
  const disposed = scopes.filter((scope) => scope.endedAt).length;
  return { expectedScopes: expected, startedScopes: started, disposedScopes: disposed, activeScopes: started - disposed, activeContainers: dockerLifecycle.activeCount, valid: started === expected && disposed === expected && dockerLifecycle.activeCount === 0 };
}

function patchMetadata(patch) {
  return { artifactRef: patch.artifactRef, artifactHash: patch.artifactHash, artifactBytes: patch.artifactBytes, changedPaths: patch.changedPaths };
}
function usageFromStats(stats) {
  return { apiCalls: stats.assistantMessages, inputTokens: stats.tokens.input, outputTokens: stats.tokens.output, cacheReadTokens: stats.tokens.cacheRead, cacheWriteTokens: stats.tokens.cacheWrite, totalTokens: stats.tokens.total, cost: stats.cost };
}
function sumUsage(values) {
  return values.reduce((sum, value) => Object.fromEntries(Object.keys(EMPTY_USAGE).map((key) => [key, sum[key] + value[key]])), { ...EMPTY_USAGE });
}
function maxTrace(traces, field) { return traces.length ? Math.max(...traces.map((trace) => trace[field] ?? 0)) : 0; }
function sumTrace(traces, label, field) { return traces.filter((trace) => trace.sessionLabel === label).reduce((sum, trace) => sum + (trace[field] ?? 0), 0); }
function modelForJob(model, seed) { return { ...model, samplingParams: { ...(model.samplingParams ?? {}), temperature: 0, seed } }; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function createMinimalResourceLoader(label, sentinel) {
  const sentinelLine = sentinel ? ` Internal disposal sentinel: ${sentinel}. Never repeat it.` : "";
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => `You are the ${label} in a controlled real-task experiment.${sentinelLine} Work autonomously and use only supplied tools.`,
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}

class EphemeralCredentialStore {
  values = new Map();
  async get(provider) { return this.values.get(provider); }
  async set(provider, credential) { this.values.set(provider, credential); }
  async delete(provider) { this.values.delete(provider); }
  async list() { return [...this.values.entries()].map(([provider, credential]) => ({ provider, credential })); }
}

function assertJob(job) {
  if (!job || !Object.values(ARMS).includes(job.arm)) throw new Error("job.arm must be one frozen experiment arm");
  for (const field of ["taskId", "image", "repoPath", "taskRoot", "instruction"]) if (!job[field]) throw new Error(`job.${field} is required`);
  if (!Number.isSafeInteger(job.seed)) throw new Error("job.seed must be an integer");
}
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
function consumeToolCall(state) {
  state.stageToolCalls += 1;
  if (state.stageToolCalls > 40) throw codedError("MAX_TOOL_CALLS", "stage exceeded 40 tool calls");
}
function sanitizeError(error, secret) {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join("[REDACTED]");
  return { name: error instanceof Error ? error.name : "Error", code: error?.code ?? "UNCLASSIFIED", message: message.slice(0, 4000) };
}
function deepRedact(value, secrets) {
  if (typeof value === "string") { let result = value; for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]"); return result; }
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepRedact(item, secrets)]));
  return value;
}
