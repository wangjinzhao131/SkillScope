import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { MODEL, PARENT_BUDGET } from "./protocol.mjs";

const EMPTY_USAGE = Object.freeze({
  scopes: 0,
  apiCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  cost: 0,
  wallTimeMs: 0,
});

export async function createLiveEnvironment(apiKey, { skillsRoot, traceRoot } = {}) {
  if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("EXPERIMENT_KEY is required in memory");
  const credentials = new EphemeralCredentialStore();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const catalogModel = modelRuntime.getModel(MODEL.provider, MODEL.id);
  if (!catalogModel) throw new Error(`${MODEL.provider}/${MODEL.id} is absent from the Pi catalog`);
  if (catalogModel.api !== MODEL.piTransport || catalogModel.baseUrl !== MODEL.apiBase) {
    throw new Error(`Model identity mismatch: ${catalogModel.api} ${catalogModel.baseUrl}`);
  }
  await modelRuntime.setRuntimeApiKey(MODEL.provider, apiKey);
  await modelRuntime.refresh({ providers: [MODEL.provider], allowNetwork: false });
  return {
    apiKey,
    modelRuntime,
    modelRegistry: new ModelRegistry(modelRuntime),
    catalogModel,
    skillsRoot,
    traceRoot,
    async dispose() {
      await modelRuntime.removeRuntimeApiKey(MODEL.provider).catch(() => {});
    },
  };
}

export async function runParentContextJob(job, environment, options = {}) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "skillscope-parent-context-"));
  const projectRoot = join(temporaryRoot, "project");
  const traceRoot = environment.traceRoot ?? join(temporaryRoot, "traces");
  let runtime;
  let parentSession;
  let conditionObservation = emptyConditionObservation(job.condition);
  try {
    await materializeProject(projectRoot, job.packets.files);
    const model = modelForJob(environment.catalogModel, job.seed);
    const runtimeModules = await loadRuntimeModules();
    runtime = new runtimeModules.SkillScopeRuntime({
      registry: new runtimeModules.SkillRegistry(environment.skillsRoot),
      backend: new runtimeModules.PiInProcessBackend({ gatewayFactory: new runtimeModules.CoreResourceGatewayFactory() }),
      traceStore: new runtimeModules.TraceStore(traceRoot),
      maxScopeDepth: 1,
    });
    const completion = createParentCompletionTool();
    const condition = createConditionTools({
      job,
      environment,
      model,
      runtime,
      projectRoot,
      completion,
      onObservation(value) { conditionObservation = value; },
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const { session } = await createAgentSession({
      cwd: projectRoot,
      modelRuntime: environment.modelRuntime,
      model,
      thinkingLevel: "off",
      noTools: "all",
      tools: [...condition.tools.map((tool) => tool.name), completion.tool.name],
      customTools: [...condition.tools, completion.tool],
      resourceLoader: createMinimalResourceLoader("parent workflow controller"),
      settingsManager,
      sessionManager: SessionManager.inMemory(projectRoot),
    });
    parentSession = session;
    let parentTurns = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start") {
        parentTurns += 1;
        if (parentTurns > (job.parentBudget?.maxTurns ?? PARENT_BUDGET.maxTurns)) void session.abort();
      }
      if (event.type === "message_end") completion.observeAssistantMessage(event.message);
    });
    const timeoutMs = job.parentBudget?.timeoutMs ?? PARENT_BUDGET.timeoutMs;
    const timer = setTimeout(() => void session.abort(), timeoutMs);
    let promptError;
    try {
      await session.prompt(parentPrompt(job, condition.guidance), { expandPromptTemplates: false });
    } catch (error) {
      promptError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }

    const parentMetrics = measureParentSession(session, job.sentinel);
    const parentStats = session.getSessionStats();
    const submitted = completion.getCompletion();
    const verification = verifyParentCompletion(job, submitted, promptError, parentTurns, timeoutMs);
    const lifecycle = runtime.getLifecycleSnapshot();
    const wallTimeMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    const parentUsage = usageFromStats(parentStats, 0);
    const treeUsage = addUsage(parentUsage, conditionObservation.childUsage);
    const record = {
      schemaVersion: "parent-context.result.v1",
      protocolVersion: job.protocolVersion,
      jobId: job.jobId,
      blockId: job.blockId,
      familyId: job.familyId,
      repeat: job.repeat,
      condition: job.condition,
      seed: job.seed,
      status: verification.hardPass ? "completed" : promptError ? "provider_error" : "capability_failure",
      startedAt,
      endedAt: new Date().toISOString(),
      wallTimeMs,
      verification,
      parentResult: submitted,
      parentMetrics,
      usage: {
        parent: parentUsage,
        children: conditionObservation.childUsage,
        tree: treeUsage,
      },
      lifecycle: {
        runtime: lifecycle,
        externalScopesStarted: conditionObservation.externalScopesStarted,
        externalScopesDisposed: conditionObservation.externalScopesDisposed,
        expectedRuntimeScopes: expectedRuntimeScopes(job.condition),
        valid: lifecycleValid(job.condition, lifecycle, conditionObservation),
      },
      scopes: conditionObservation.scopeProjection,
      sentinel: {
        sha256: digestText(job.sentinel),
        visibleInParent: parentMetrics.childSentinelVisibleInParent,
        expectedVisibleInParent: job.condition === "INLINE_PARENT",
      },
      error: promptError ? sanitizeError(promptError, environment.apiKey, job.sentinel) : undefined,
    };
    const sanitized = deepRedact(record, [environment.apiKey, job.sentinel]);
    assertNoSecretOrSentinel(sanitized, environment.apiKey, job.sentinel);
    return sanitized;
  } catch (error) {
    const wallTimeMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    const record = {
      schemaVersion: "parent-context.result.v1",
      protocolVersion: job.protocolVersion,
      jobId: job.jobId,
      blockId: job.blockId,
      familyId: job.familyId,
      repeat: job.repeat,
      condition: job.condition,
      seed: job.seed,
      status: "harness_error",
      startedAt,
      endedAt: new Date().toISOString(),
      wallTimeMs,
      verification: { hardPass: false, failureCode: "HARNESS_ERROR" },
      parentMetrics: undefined,
      usage: { parent: EMPTY_USAGE, children: conditionObservation.childUsage, tree: conditionObservation.childUsage },
      lifecycle: runtime ? { runtime: runtime.getLifecycleSnapshot(), valid: false } : undefined,
      scopes: conditionObservation.scopeProjection,
      sentinel: { sha256: digestText(job.sentinel), visibleInParent: false, expectedVisibleInParent: job.condition === "INLINE_PARENT" },
      error: sanitizeError(error, environment.apiKey, job.sentinel),
    };
    const sanitized = deepRedact(record, [environment.apiKey, job.sentinel]);
    assertNoSecretOrSentinel(sanitized, environment.apiKey, job.sentinel);
    return sanitized;
  } finally {
    parentSession?.dispose();
    await runtime?.dispose();
    if (!options.keepTemporaryProject) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function createConditionTools(args) {
  if (args.job.condition === "INLINE_PARENT") return createInlineTools(args);
  return createDelegationTool(args);
}

function createInlineTools({ job, projectRoot, onObservation }) {
  const state = emptyConditionObservation(job.condition);
  onObservation(state);
  const schema = Type.Object({}, { additionalProperties: false });
  const makeTool = (name, path, label) => defineTool({
    name,
    label,
    description: `Read the exact ${label} packet into the parent session.`,
    executionMode: "parallel",
    parameters: schema,
    async execute() {
      const content = await readFile(join(projectRoot, path), "utf8");
      return { content: [{ type: "text", text: content }], details: { path, bytes: Buffer.byteLength(content) } };
    },
  });
  return {
    tools: [
      makeTool("read_constraint_packet", job.packets.constraintPath, "constraint"),
      makeTool("read_observation_packet", job.packets.observationPath, "observation"),
    ],
    guidance: "Call both read_constraint_packet and read_observation_packet, observe both results, then decide.",
  };
}

function createDelegationTool(args) {
  const schema = Type.Object({}, { additionalProperties: false });
  return {
    tools: [defineTool({
      name: "run_disposable_worker",
      label: "Run disposable workflow worker",
      description: "Run this workflow in a fresh disposable worker context and return its final answer to the parent.",
      executionMode: "sequential",
      parameters: schema,
      async execute(_toolCallId, _params, signal) {
        const observation = args.job.condition === "EPHEMERAL_FREEFORM"
          ? await runFreeformChild(args, signal)
          : await runSkillScopeChild(args, signal);
        args.onObservation(observation);
        return { content: [{ type: "text", text: observation.parentProjection }], details: observation.scopeProjection };
      },
    })],
    guidance: "Call run_disposable_worker once, consume its returned answer, then decide. The worker context is not inherited by you.",
  };
}

async function runFreeformChild({ job, environment, model, projectRoot }, signal) {
  const scopeId = randomUUID();
  const startedNs = process.hrtime.bigint();
  const reads = exactReadTools(job, projectRoot);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } });
  let session;
  try {
    ({ session } = await createAgentSession({
      cwd: projectRoot,
      modelRuntime: environment.modelRuntime,
      model,
      thinkingLevel: "off",
      noTools: "all",
      tools: reads.map((tool) => tool.name),
      customTools: reads,
      resourceLoader: createMinimalResourceLoader("disposable freeform worker"),
      settingsManager,
      sessionManager: SessionManager.inMemory(projectRoot),
    }));
    if (signal) signal.addEventListener("abort", () => void session.abort(), { once: true });
    await session.prompt(freeformPrompt(job), { expandPromptTemplates: false });
    const text = session.getLastAssistantText() ?? "";
    const stats = session.getSessionStats();
    const usage = usageFromStats(stats, Number(process.hrtime.bigint() - startedNs) / 1e6, 1);
    return {
      parentProjection: text,
      childUsage: usage,
      externalScopesStarted: 1,
      externalScopesDisposed: 1,
      scopeProjection: [{ scopeId, kind: "freeform", status: text.length > 0 ? "completed" : "empty", resultBytes: Buffer.byteLength(text), usage }],
    };
  } finally {
    session?.dispose();
  }
}

async function runSkillScopeChild({ job, environment, model, runtime, projectRoot }, signal) {
  const skill = job.condition === "SKILLSCOPE_FLAT" ? "workflow-flat" : "workflow-main";
  const result = await runtime.invoke({
    skill,
    input: workflowInput(job),
    accessMode: "BOUNDED",
    resourceGrants: [
      { path: job.packets.constraintPath, kind: "file", operations: ["read"] },
      { path: job.packets.observationPath, kind: "file", operations: ["read"] },
    ],
  }, {
    cwd: projectRoot,
    parentSessionId: `parent-${job.jobId.slice(-16)}`,
    signal,
    hostContext: { model, modelRegistry: environment.modelRegistry, thinkingLevel: "off" },
  });
  const compact = {
    status: result.status,
    summary: result.summary,
    data: result.data,
    warnings: result.warnings,
    error: result.error,
  };
  const childUsage = usageFromTree(result.treeUsage, result.usage.wallTimeMs);
  const scopes = [{
    scopeId: result.scopeId,
    parentScopeId: result.parentScopeId,
    rootScopeId: result.rootScopeId,
    depth: result.depth,
    skill: result.skill.name,
    status: result.status,
    resultBytes: Buffer.byteLength(JSON.stringify(compact)),
    usage: result.usage,
  }, ...result.childScopes.map((child) => ({
    scopeId: child.scopeId,
    parentScopeId: child.parentScopeId,
    rootScopeId: child.rootScopeId,
    depth: child.depth,
    skill: child.skill.name,
    status: child.status,
    resultBytes: child.resultBytes,
    usage: child.usage,
  }))];
  return {
    parentProjection: JSON.stringify(compact),
    childUsage,
    externalScopesStarted: 0,
    externalScopesDisposed: 0,
    scopeProjection: scopes,
  };
}

function exactReadTools(job, projectRoot) {
  const schema = Type.Object({}, { additionalProperties: false });
  return [
    ["read_constraint_packet", job.packets.constraintPath],
    ["read_observation_packet", job.packets.observationPath],
  ].map(([name, path]) => defineTool({
    name,
    label: name,
    description: `Read exact evidence file ${path}.`,
    executionMode: "parallel",
    parameters: schema,
    async execute() {
      const content = await readFile(join(projectRoot, path), "utf8");
      return { content: [{ type: "text", text: content }], details: { path, bytes: Buffer.byteLength(content) } };
    },
  }));
}

function createParentCompletionTool() {
  let completion;
  let duplicate = false;
  const rejectedBatchIds = new Set();
  const schema = Type.Object({
    decision: Type.Union([Type.Literal("ALLOW"), Type.Literal("BLOCK")]),
    constraintFact: Type.String({ minLength: 1, maxLength: 256 }),
    observationFact: Type.String({ minLength: 1, maxLength: 256 }),
    memoryCode: Type.String({ minLength: 1, maxLength: 128 }),
  }, { additionalProperties: false });
  const tool = defineTool({
    name: "parent_complete",
    label: "Complete parent workflow",
    description: "Submit the final workflow decision, both exact facts, and the unchanged memory code.",
    executionMode: "sequential",
    parameters: schema,
    async execute(toolCallId, params) {
      if (rejectedBatchIds.has(toolCallId)) {
        return { content: [{ type: "text", text: "Observe other tool results first; call parent_complete alone on a later turn." }], details: { accepted: false, code: "COMPLETION_HAS_SIBLING_TOOL" } };
      }
      if (completion) {
        duplicate = true;
        return { content: [{ type: "text", text: "parent_complete may be accepted only once." }], details: { accepted: false, code: "DUPLICATE_COMPLETION" }, terminate: true };
      }
      completion = structuredClone(params);
      return { content: [{ type: "text", text: "Parent workflow completed." }], details: { accepted: true }, terminate: true };
    },
  });
  return {
    tool,
    getCompletion: () => completion,
    get duplicate() { return duplicate; },
    observeAssistantMessage(message) {
      const calls = assistantToolCalls(message);
      if (calls.length <= 1) return;
      for (const call of calls) if (call.name === "parent_complete") rejectedBatchIds.add(call.id);
    },
  };
}

function parentPrompt(job, guidance) {
  return [
    "You are the parent workflow controller.",
    `Question: ${job.family.question}`,
    `Decision rule: ${job.family.decisionRule}`,
    `Memory code: ${job.memoryCode}`,
    guidance,
    "Do not guess. After observing the needed result(s), call parent_complete alone on a later assistant turn.",
    "Copy the two authoritative fact values exactly and preserve the memory code exactly.",
    "Never include work logs or CHILD_CONTEXT_SENTINEL text in your final result.",
  ].join("\n");
}

function freeformPrompt(job) {
  return [
    "You are a fresh disposable worker. You do not inherit parent conversation history.",
    `Question: ${job.family.question}`,
    `Decision rule: ${job.family.decisionRule}`,
    `Constraint file: ${job.packets.constraintPath}`,
    `Observation file: ${job.packets.observationPath}`,
    "Read both exact files, extract AUTHORITATIVE_CONSTRAINT_FACT and AUTHORITATIVE_OBSERVATION_FACT, and apply the rule.",
    "Return a concise free-text answer containing the decision and both exact facts. There is no output schema.",
    "Do not copy work-log lines or CHILD_CONTEXT_SENTINEL text.",
  ].join("\n");
}

function workflowInput(job) {
  return {
    question: job.family.question,
    decisionRule: job.family.decisionRule,
    constraintPath: job.packets.constraintPath,
    observationPath: job.packets.observationPath,
  };
}

function verifyParentCompletion(job, submitted, promptError, turns, timeoutMs) {
  if (promptError) return { hardPass: false, failureCode: "PROVIDER_OR_SESSION_ERROR", parentTurns: turns, timeoutMs };
  if (!submitted) return { hardPass: false, failureCode: turns > (job.parentBudget?.maxTurns ?? PARENT_BUDGET.maxTurns) ? "MAX_PARENT_TURNS" : "MISSING_PARENT_COMPLETE", parentTurns: turns, timeoutMs };
  const checks = {
    decision: submitted.decision === job.family.expectedDecision,
    constraintFact: submitted.constraintFact === job.family.constraintFact,
    observationFact: submitted.observationFact === job.family.observationFact,
    memoryCode: submitted.memoryCode === job.memoryCode,
  };
  const hardPass = Object.values(checks).every(Boolean);
  return { hardPass, failureCode: hardPass ? null : "WRONG_PARENT_RESULT", checks, parentTurns: turns, timeoutMs };
}

function measureParentSession(session, sentinel) {
  const messages = session.messages;
  const visible = convertToLlm(messages);
  const serialized = JSON.stringify(visible);
  const provider = session.getContextUsage();
  return {
    parentProviderContextTokens: provider?.tokens ?? null,
    parentEstimatedContextTokens: messages.reduce((total, message) => total + estimateTokens(message), 0),
    parentMessageBytes: Buffer.byteLength(serialized),
    parentToolResultBytes: visible.filter((message) => message.role === "toolResult").reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message.content)), 0),
    childSentinelVisibleInParent: serialized.includes(sentinel),
    parentMessageCount: visible.length,
  };
}

function lifecycleValid(condition, runtimeSnapshot, observation) {
  if (runtimeSnapshot.activeScopeIds.length !== 0 || runtimeSnapshot.startedScopes !== runtimeSnapshot.disposedScopes) return false;
  if (condition === "SKILLSCOPE_FLAT") return runtimeSnapshot.startedScopes === 1 && observation.scopeProjection.length === 1;
  if (condition === "SKILLSCOPE_NESTED") {
    if (runtimeSnapshot.startedScopes !== 3 || observation.scopeProjection.length !== 3) return false;
    const roots = observation.scopeProjection.filter((scope) => scope.depth === 0);
    const children = observation.scopeProjection.filter((scope) => scope.depth === 1);
    return roots.length === 1 && children.length === 2 && children.every((child) => child.parentScopeId === roots[0].scopeId && child.rootScopeId === roots[0].scopeId);
  }
  if (condition === "EPHEMERAL_FREEFORM") return observation.externalScopesStarted === 1 && observation.externalScopesDisposed === 1;
  return runtimeSnapshot.startedScopes === 0;
}

function expectedRuntimeScopes(condition) {
  if (condition === "SKILLSCOPE_FLAT") return 1;
  if (condition === "SKILLSCOPE_NESTED") return 3;
  return 0;
}

function emptyConditionObservation() {
  return { parentProjection: "", childUsage: { ...EMPTY_USAGE }, externalScopesStarted: 0, externalScopesDisposed: 0, scopeProjection: [] };
}

function usageFromStats(stats, wallTimeMs, scopes = 0) {
  return {
    scopes,
    apiCalls: stats.assistantMessages,
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    cost: stats.cost,
    wallTimeMs,
  };
}

function usageFromTree(tree, wallTimeMs) {
  return {
    scopes: tree.scopes,
    apiCalls: tree.turns,
    inputTokens: tree.inputTokens,
    outputTokens: tree.outputTokens,
    cacheReadTokens: tree.cacheReadTokens,
    cacheWriteTokens: tree.cacheWriteTokens,
    totalTokens: tree.totalTokens,
    cost: tree.cost,
    wallTimeMs,
  };
}

function addUsage(left, right) {
  return {
    scopes: left.scopes + right.scopes,
    apiCalls: left.apiCalls + right.apiCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: left.cost + right.cost,
    wallTimeMs: left.wallTimeMs + right.wallTimeMs,
  };
}

function modelForJob(model, seed) {
  return { ...model, samplingParams: { ...(model.samplingParams ?? {}), temperature: 0, seed } };
}

async function materializeProject(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
}

function assistantToolCalls(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string" ? [{ id: part.id, name: part.name }] : []);
}

function createMinimalResourceLoader(label) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => `You are a ${label}. Use only the supplied custom tools and follow the user task.`,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function loadRuntimeModules() {
  const [runtime, registry, backend, gateway, trace] = await Promise.all([
    import("../../../src/pi/runtime.ts"),
    import("../../../src/pi/skill-registry.ts"),
    import("../../../src/pi/pi-backend.ts"),
    import("../../../src/pi/core-resource-gateway.ts"),
    import("../../../src/pi/trace-store.ts"),
  ]);
  return {
    SkillScopeRuntime: runtime.SkillScopeRuntime,
    SkillRegistry: registry.SkillRegistry,
    PiInProcessBackend: backend.PiInProcessBackend,
    CoreResourceGatewayFactory: gateway.CoreResourceGatewayFactory,
    TraceStore: trace.TraceStore,
  };
}

function sanitizeError(error, apiKey, sentinel) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [apiKey, sentinel]) if (secret) message = message.split(secret).join("[REDACTED]");
  return { name: error instanceof Error ? error.name : "Error", message: message.slice(0, 2000) };
}

function assertNoSecretOrSentinel(value, apiKey, sentinel) {
  const serialized = JSON.stringify(value);
  if (apiKey && serialized.includes(apiKey)) throw new Error("Refusing to return an artifact containing EXPERIMENT_KEY");
  if (sentinel && serialized.includes(sentinel)) throw new Error("Refusing to return an artifact containing a child-context sentinel");
}

function digestText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepRedact(value, secrets) {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepRedact(item, secrets)]));
  return value;
}

class EphemeralCredentialStore {
  constructor() {
    this.credentials = new Map();
    this.chains = new Map();
  }
  async read(providerId) { return this.credentials.get(providerId); }
  async list() { return [...this.credentials.entries()].map(([providerId, credential]) => ({ providerId, type: credential.type })); }
  async modify(providerId, fn) {
    const prior = this.chains.get(providerId) ?? Promise.resolve();
    let result;
    const next = prior.then(async () => {
      const candidate = await fn(this.credentials.get(providerId));
      if (candidate === undefined) this.credentials.delete(providerId);
      else this.credentials.set(providerId, candidate);
      result = this.credentials.get(providerId);
    });
    this.chains.set(providerId, next);
    await next;
    if (this.chains.get(providerId) === next) this.chains.delete(providerId);
    return result;
  }
  async delete(providerId) { this.credentials.delete(providerId); }
}
