import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertToLlm,
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  estimateTokens,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PARENT_BUDGET } from "./protocol.mjs";
export { createLiveEnvironment } from "../../parent-context/src/live-harness.mjs";

const EMPTY_USAGE = Object.freeze({ scopes: 0, apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, wallTimeMs: 0 });

export async function runCompositionJob(job, environment, options = {}) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "skillscope-composition-"));
  const projectRoot = join(temporaryRoot, "project");
  const traceRoot = environment.traceRoot ?? join(temporaryRoot, "traces");
  let runtime;
  let parentSession;
  let observation = emptyObservation();
  try {
    await materializeProject(projectRoot, job.packets.files);
    const model = modelForJob(environment.catalogModel, job.seed);
    const modules = await loadRuntimeModules();
    runtime = new modules.SkillScopeRuntime({
      registry: new modules.SkillRegistry(environment.skillsRoot),
      backend: new modules.PiInProcessBackend({
        gatewayFactory: new modules.CoreResourceGatewayFactory(),
        ...(environment.createChildModelRuntime ? { createModelRuntime: environment.createChildModelRuntime } : {}),
      }),
      traceStore: new modules.TraceStore(traceRoot),
      maxScopeDepth: 1,
    });
    const completion = createParentCompletionTool();
    const workflowTool = createWorkflowTool({ job, environment, model, runtime, projectRoot, onObservation(value) { observation = value; } });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } });
    const { session } = await createAgentSession({
      cwd: projectRoot,
      modelRuntime: environment.modelRuntime,
      model,
      thinkingLevel: "off",
      noTools: "all",
      tools: [workflowTool.name, completion.tool.name],
      customTools: [workflowTool, completion.tool],
      resourceLoader: createMinimalResourceLoader("parent composition controller"),
      settingsManager,
      sessionManager: SessionManager.inMemory(projectRoot),
    });
    parentSession = session;
    let parentTurns = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start") { parentTurns += 1; if (parentTurns > (job.parentBudget?.maxTurns ?? PARENT_BUDGET.maxTurns)) void session.abort(); }
      if (event.type === "message_end") completion.observeAssistantMessage(event.message);
    });
    const timeoutMs = job.parentBudget?.timeoutMs ?? PARENT_BUDGET.timeoutMs;
    const timer = setTimeout(() => void session.abort(), timeoutMs);
    let promptError;
    try { await session.prompt(parentPrompt(job), { expandPromptTemplates: false }); }
    catch (error) { promptError = error instanceof Error ? error : new Error(String(error)); }
    finally { clearTimeout(timer); unsubscribe(); }

    const parentMetrics = measureParentSession(session, job.sentinel);
    const submitted = completion.getCompletion();
    const topology = auditTopology(job, observation);
    const verification = verifyParentCompletion(job, submitted, promptError, parentTurns, timeoutMs, observation, topology);
    const lifecycleSnapshot = runtime.getLifecycleSnapshot();
    const lifecycle = {
      runtime: lifecycleSnapshot,
      expectedScopes: 3,
      valid: lifecycleSnapshot.startedScopes === 3
        && lifecycleSnapshot.disposedScopes === 3
        && lifecycleSnapshot.activeScopeIds.length === 0
        && observation.scopes.length === 3,
    };
    if (!lifecycle.valid) { verification.hardPass = false; verification.failureCode = "LIFECYCLE_INVALID"; }
    const wallTimeMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    const parentUsage = usageFromStats(session.getSessionStats(), 0);
    const treeUsage = addUsage(parentUsage, observation.treeUsage);
    const status = promptError ? "provider_error" : verification.hardPass ? "completed" : "capability_failure";
    const record = {
      schemaVersion: "composition-topology.result.v1",
      protocolVersion: job.protocolVersion,
      jobId: job.jobId,
      blockId: job.blockId,
      familyId: job.familyId,
      dependencyDirection: job.family.dependencyDirection,
      repeat: job.repeat,
      condition: job.condition,
      compositionMode: job.compositionMode ?? job.condition,
      seed: job.seed,
      status,
      startedAt,
      endedAt: new Date().toISOString(),
      wallTimeMs,
      verification,
      parentResult: submitted,
      mainResult: observation.mainData,
      mainEvidenceRefs: observation.mainEvidenceRefs,
      parentMetrics,
      usage: { parent: parentUsage, main: observation.mainUsage, children: observation.childUsage, tree: treeUsage },
      topology,
      lifecycle,
      scopes: observation.scopes,
      sentinel: { sha256: digestText(job.sentinel), visibleInParent: parentMetrics.sentinelVisibleInParent },
      error: promptError ? sanitizeError(promptError, environment.apiKey, job.sentinel) : observation.error,
    };
    const sanitized = deepRedact(record, [environment.apiKey, job.sentinel]);
    assertNoSecretOrSentinel(sanitized, environment.apiKey, job.sentinel);
    return sanitized;
  } catch (error) {
    const record = {
      schemaVersion: "composition-topology.result.v1",
      protocolVersion: job.protocolVersion,
      jobId: job.jobId,
      blockId: job.blockId,
      familyId: job.familyId,
      dependencyDirection: job.family.dependencyDirection,
      repeat: job.repeat,
      condition: job.condition,
      seed: job.seed,
      status: "harness_error",
      startedAt,
      endedAt: new Date().toISOString(),
      wallTimeMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
      verification: { hardPass: false, schemaPass: false, failureCode: "HARNESS_ERROR" },
      usage: { parent: EMPTY_USAGE, main: observation.mainUsage, children: observation.childUsage, tree: observation.treeUsage },
      lifecycle: runtime ? { runtime: runtime.getLifecycleSnapshot(), expectedScopes: 3, valid: false } : undefined,
      scopes: observation.scopes,
      sentinel: { sha256: digestText(job.sentinel), visibleInParent: false },
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

function createWorkflowTool({ job, environment, model, runtime, projectRoot, onObservation }) {
  return defineTool({
    name: "run_composed_workflow",
    label: "Run composed Skill workflow",
    description: "Run the frozen SkillScope composition and return only its Runtime-validated main result.",
    executionMode: "sequential",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, signal) {
      const result = await runtime.invoke({
        skill: "workflow-compose",
        input: {
          question: job.family.question,
          routingCue: job.family.routingCue,
          decisionRule: job.family.decisionRule,
          compositionMode: job.compositionMode ?? job.condition,
          constraintPath: job.packets.constraintPath,
          observationPath: job.packets.observationPath,
        },
        accessMode: "BOUNDED",
        resourceGrants: [
          { path: job.packets.constraintPath, kind: "file", operations: ["read"] },
          { path: job.packets.observationPath, kind: "file", operations: ["read"] },
        ],
      }, {
        cwd: projectRoot,
        parentSessionId: `composition-parent-${job.jobId.slice(-16)}`,
        signal,
        hostContext: { model, modelRegistry: environment.modelRegistry, thinkingLevel: "off" },
      });
      const mainData = result.data && typeof result.data === "object" ? structuredClone(result.data) : undefined;
      const compact = { status: result.status, summary: result.summary, data: mainData, warnings: result.warnings, error: result.error };
      const scopes = [scopeProjection(result), ...result.childScopes.map(scopeProjection)];
      const childUsage = result.childScopes.reduce((usage, child) => addUsage(usage, usageFromTree(child.treeUsage, child.usage.wallTimeMs)), { ...EMPTY_USAGE });
      const value = {
        parentProjection: JSON.stringify(compact),
        mainData,
        mainEvidenceRefs: structuredClone(result.evidenceRefs),
        mainUsage: usageFromScope(result.usage),
        childUsage,
        treeUsage: usageFromTree(result.treeUsage, result.usage.wallTimeMs),
        scopes,
        error: result.error,
      };
      onObservation(value);
      return { content: [{ type: "text", text: value.parentProjection }], details: scopes };
    },
  });
}

function scopeProjection(scope) {
  return {
    scopeId: scope.scopeId,
    parentScopeId: scope.parentScopeId,
    rootScopeId: scope.rootScopeId,
    depth: scope.depth,
    skill: scope.skill.name,
    status: scope.status,
    resultBytes: scope.resultBytes,
    usage: scope.usage,
    startedAt: scope.startedAt,
    endedAt: scope.endedAt,
  };
}

function auditTopology(job, observation) {
  const compositionMode = job.compositionMode ?? job.condition;
  const children = observation.scopes.filter((scope) => scope.depth === 1);
  const sameAtomicSkill = children.length === 2 && children.every((scope) => scope.skill === "inspect-contextual-evidence");
  const intervalsOverlap = children.length === 2 && overlap(children[0], children[1]);
  const expectedFirstRole = compositionMode === "PARALLEL_JOIN"
    ? "parallel"
    : compositionMode === "CONSTRAINT_FIRST"
      ? "constraint"
      : compositionMode === "OBSERVATION_FIRST"
        ? "observation"
        : compositionMode === "MODEL_ROUTE" && job.family.dependencyDirection === "independent"
          ? "parallel"
          : job.family.dependencyDirection === "observation-first" ? "observation" : "constraint";
  const observedFirstRole = observation.mainData?.observedFirstRole;
  const upstreamPassedToSecond = observation.mainData?.upstreamPassedToSecond;
  const timingValid = expectedFirstRole === "parallel" ? intervalsOverlap : !intervalsOverlap;
  const directionValid = compositionMode === "ADAPTIVE_ORDER" && job.family.dependencyDirection === "independent"
    ? ["constraint", "observation"].includes(observedFirstRole)
    : observedFirstRole === expectedFirstRole;
  const upstreamValid = upstreamPassedToSecond === (expectedFirstRole !== "parallel");
  return { compositionMode, expectedFirstRole, observedFirstRole, upstreamPassedToSecond, childIntervalsOverlap: intervalsOverlap, sameAtomicSkill, timingValid, directionValid, upstreamValid, valid: sameAtomicSkill && timingValid && directionValid && upstreamValid };
}

function overlap(left, right) {
  const leftStart = Date.parse(left.startedAt); const leftEnd = Date.parse(left.endedAt);
  const rightStart = Date.parse(right.startedAt); const rightEnd = Date.parse(right.endedAt);
  return [leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite) && Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd);
}

function createParentCompletionTool() {
  let completion;
  let duplicate = false;
  const rejectedBatchIds = new Set();
  const tool = defineTool({
    name: "parent_complete",
    label: "Complete parent composition task",
    description: "Submit the composed decision, both facts, and unchanged memory code.",
    executionMode: "sequential",
    parameters: Type.Object({
      decision: Type.Union([Type.Literal("ALLOW"), Type.Literal("BLOCK"), Type.Literal("ABSTAIN")]),
      constraintFact: Type.String({ minLength: 1, maxLength: 256 }),
      observationFact: Type.String({ minLength: 1, maxLength: 256 }),
      memoryCode: Type.String({ minLength: 1, maxLength: 128 }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params) {
      if (rejectedBatchIds.has(toolCallId)) return { content: [{ type: "text", text: "Observe the workflow result first; call parent_complete alone later." }], details: { accepted: false, code: "COMPLETION_HAS_SIBLING_TOOL" } };
      if (completion) { duplicate = true; return { content: [{ type: "text", text: "parent_complete may be accepted only once." }], details: { accepted: false, code: "DUPLICATE_COMPLETION" }, terminate: true }; }
      completion = structuredClone(params);
      return { content: [{ type: "text", text: "Parent composition task completed." }], details: { accepted: true }, terminate: true };
    },
  });
  return {
    tool,
    getCompletion: () => completion,
    get duplicate() { return duplicate; },
    observeAssistantMessage(message) { const calls = assistantToolCalls(message); if (calls.length > 1) for (const call of calls) if (call.name === "parent_complete") rejectedBatchIds.add(call.id); },
  };
}

function parentPrompt(job) {
  return [
    "You are the parent controller for a frozen SkillScope composition experiment.",
    `Question: ${job.family.question}`,
    `Memory code: ${job.memoryCode}`,
    "Call run_composed_workflow exactly once. It returns one compact Runtime-validated result.",
    "After observing it, call parent_complete alone on a later turn and copy decision, constraintFact, and observationFact exactly; preserve memoryCode exactly.",
    "Do not guess, inspect files, or include packet text, work logs, or COMPOSITION_SENTINEL text.",
  ].join("\n");
}

function verifyParentCompletion(job, submitted, promptError, turns, timeoutMs, observation, topology) {
  if (promptError) return { hardPass: false, schemaPass: false, abstained: false, confidentWrong: false, failureCode: "PROVIDER_OR_SESSION_ERROR", parentTurns: turns, timeoutMs };
  if (!submitted) return { hardPass: false, schemaPass: false, abstained: false, confidentWrong: false, failureCode: "MISSING_PARENT_COMPLETE", parentTurns: turns, timeoutMs };
  const checks = {
    decision: submitted.decision === job.family.expectedDecision,
    constraintFact: submitted.constraintFact === job.family.constraintFact,
    observationFact: submitted.observationFact === job.family.observationFact,
    memoryCode: submitted.memoryCode === job.memoryCode,
    mainStatus: observation.scopes.find((scope) => scope.depth === 0)?.status === "SUCCESS",
    childStatuses: observation.scopes.filter((scope) => scope.depth === 1).length === 2 && observation.scopes.filter((scope) => scope.depth === 1).every((scope) => scope.status === "SUCCESS"),
    topology: topology.valid,
  };
  const hardPass = Object.values(checks).every(Boolean);
  const abstained = submitted.decision === "ABSTAIN";
  const confidentWrong = ["ALLOW", "BLOCK"].includes(submitted.decision)
    && (!checks.decision || !checks.constraintFact || !checks.observationFact);
  const failureCode = hardPass ? null : !checks.topology ? "TOPOLOGY_INVALID" : abstained ? "ABSTAINED" : "WRONG_PARENT_RESULT";
  return { hardPass, schemaPass: true, abstained, confidentWrong, failureCode, checks, parentTurns: turns, timeoutMs };
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
    sentinelVisibleInParent: serialized.includes(sentinel),
    parentMessageCount: visible.length,
  };
}

function emptyObservation() { return { parentProjection: "", mainData: undefined, mainEvidenceRefs: [], mainUsage: { ...EMPTY_USAGE }, childUsage: { ...EMPTY_USAGE }, treeUsage: { ...EMPTY_USAGE }, scopes: [], error: undefined }; }
function usageFromStats(stats, wallTimeMs, scopes = 0) { return { scopes, apiCalls: stats.assistantMessages, inputTokens: stats.tokens.input, outputTokens: stats.tokens.output, cacheReadTokens: stats.tokens.cacheRead, cacheWriteTokens: stats.tokens.cacheWrite, totalTokens: stats.tokens.total, cost: stats.cost, wallTimeMs }; }
function usageFromScope(scope) { return { scopes: 1, apiCalls: scope.turns, inputTokens: scope.inputTokens, outputTokens: scope.outputTokens, cacheReadTokens: scope.cacheReadTokens, cacheWriteTokens: scope.cacheWriteTokens, totalTokens: scope.totalTokens, cost: scope.cost, wallTimeMs: scope.wallTimeMs }; }
function usageFromTree(tree, wallTimeMs) { return { scopes: tree.scopes, apiCalls: tree.turns, inputTokens: tree.inputTokens, outputTokens: tree.outputTokens, cacheReadTokens: tree.cacheReadTokens, cacheWriteTokens: tree.cacheWriteTokens, totalTokens: tree.totalTokens, cost: tree.cost, wallTimeMs }; }
function addUsage(left, right) { return { scopes: left.scopes + right.scopes, apiCalls: left.apiCalls + right.apiCalls, inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens, cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens, cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens, totalTokens: left.totalTokens + right.totalTokens, cost: left.cost + right.cost, wallTimeMs: left.wallTimeMs + right.wallTimeMs }; }
function modelForJob(model, seed) { return { ...model, samplingParams: { ...(model.samplingParams ?? {}), temperature: 0, seed } }; }
async function materializeProject(root, files) { for (const [path, content] of Object.entries(files)) { const absolute = join(root, path); await mkdir(join(absolute, ".."), { recursive: true }); await writeFile(absolute, content, "utf8"); } }
function assistantToolCalls(message) { if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return []; return message.content.flatMap((part) => part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string" ? [{ id: part.id, name: part.name }] : []); }
function createMinimalResourceLoader(label) { return { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => `You are a ${label}. Use only the supplied custom tools and follow the user task.`, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {} }; }
async function loadRuntimeModules() { const [runtime, registry, backend, gateway, trace] = await Promise.all([import("../../../src/pi/runtime.ts"), import("../../../src/pi/skill-registry.ts"), import("../../../src/pi/pi-backend.ts"), import("../../../src/pi/core-resource-gateway.ts"), import("../../../src/pi/trace-store.ts")]); return { SkillScopeRuntime: runtime.SkillScopeRuntime, SkillRegistry: registry.SkillRegistry, PiInProcessBackend: backend.PiInProcessBackend, CoreResourceGatewayFactory: gateway.CoreResourceGatewayFactory, TraceStore: trace.TraceStore }; }
function sanitizeError(error, apiKey, sentinel) { let message = error instanceof Error ? error.message : String(error); for (const secret of [apiKey, sentinel]) if (secret) message = message.split(secret).join("[REDACTED]"); return { name: error instanceof Error ? error.name : "Error", message: message.slice(0, 2000) }; }
function assertNoSecretOrSentinel(value, apiKey, sentinel) { const serialized = JSON.stringify(value); if (apiKey && serialized.includes(apiKey)) throw new Error("Refusing to return an artifact containing EXPERIMENT_KEY"); if (sentinel && serialized.includes(sentinel)) throw new Error("Refusing to return an artifact containing a composition sentinel"); }
function digestText(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function deepRedact(value, secrets) { if (typeof value === "string") { let result = value; for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]"); return result; } if (Array.isArray(value)) return value.map((item) => deepRedact(item, secrets)); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepRedact(item, secrets)])); return value; }
