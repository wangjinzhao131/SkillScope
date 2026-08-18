import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  ResourceOperation,
  ScopeBackend,
  ScopeBackendRequest,
  ScopeBackendResult,
  ScopeUsage,
  SkillInvocation,
  SkillResult,
} from "./contracts.js";
import { createCompletionTool, type CompletionAttemptDecision } from "./completion-tool.js";
import { assembleChildPrompt } from "./prompt.js";
import type { ResourceGatewayFactory } from "./resource-gateway.js";

export interface PiInvocationHost {
  model: ExtensionContext["model"];
  modelRegistry: ExtensionContext["modelRegistry"];
  thinkingLevel?: ExtensionContext["thinkingLevel"];
  signal?: AbortSignal;
}

export interface PiInProcessBackendOptions {
  gatewayFactory: ResourceGatewayFactory;
  createModelRuntime?: (host: PiInvocationHost) => Promise<ModelRuntime>;
  createSession?: typeof createAgentSession;
}

type RegisteredProviderConfig = NonNullable<ReturnType<PiInvocationHost["modelRegistry"]["getRegisteredProviderConfig"]>>;
type ProviderModelDefinitions = NonNullable<RegisteredProviderConfig["models"]>;

/**
 * In-process logical isolation for Pi 0.84.2. This is not an OS sandbox: the
 * extension code retains the host process permissions, while model-visible
 * resource access is mediated by ResourceGateway.
 */
export class PiInProcessBackend implements ScopeBackend {
  private readonly options: PiInProcessBackendOptions;

  constructor(options: PiInProcessBackendOptions) {
    this.options = options;
  }

  async run(request: ScopeBackendRequest): Promise<ScopeBackendResult> {
    const host = asPiHost(request.hostContext);
    if (!host.model) return failure("failed", new Error("The parent Pi session has no selected model"));
    if (request.signal?.aborted) return failure("cancelled", abortError(request.signal));

    const parentSignal = request.signal;
    const lifecycle = new AbortController();
    let timeoutReached = false;
    let childAbort: (() => Promise<void>) | undefined;
    let childDispose: (() => void) | undefined;
    const abortActive = (reason: unknown) => {
      if (!lifecycle.signal.aborted) lifecycle.abort(reason);
      void childAbort?.();
    };
    const abortFromParent = () => abortActive(parentSignal?.reason ?? new Error("Scoped skill cancelled by parent"));
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => {
      timeoutReached = true;
      abortActive(new ScopeTimeoutError(`Scoped skill exceeded ${request.budget.timeoutMs}ms`));
    }, request.budget.timeoutMs);
    request = { ...request, signal: lifecycle.signal };

    try {
      const gateway = await raceAgainstAbort(this.options.gatewayFactory.create(request), lifecycle.signal);
      throwIfAborted(lifecycle.signal);
      const materializedRefs = await raceAgainstAbort(gateway.materializePromptRefs(request.promptRefs), lifecycle.signal);
      throwIfAborted(lifecycle.signal);
      const childPrompt = assembleChildPrompt(request, materializedRefs);
      const promptBytes = Buffer.byteLength(childPrompt, "utf8");
      if (promptBytes > request.budget.maxPromptBytes) {
        return failure("failed", new Error(`Materialized child prompt uses ${promptBytes} bytes; limit is ${request.budget.maxPromptBytes}`), gateway.snapshot());
      }

      const completionBatchDecisions = new Map<string, CompletionAttemptDecision>();
      let completionResourceAudit: ScopeBackendResult["completionResourceAudit"];
      const childResults: SkillResult[] = [];
      const completion = createCompletionTool(request.skill.outputSchema, request.budget, request.onTrace, {
        beforeAccept(toolCallId) {
          const decision = completionBatchDecisions.get(toolCallId) ?? { accept: true };
          if (decision.accept) completionResourceAudit = gateway.snapshot();
          return decision;
        },
      });
      const runtimeFactory = this.options.createModelRuntime ?? createEphemeralChildModelRuntime;
      const modelRuntime = await raceAgainstAbort(runtimeFactory({ ...host, signal: request.signal }), lifecycle.signal);
      throwIfAborted(lifecycle.signal);
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1 },
      });
      const resourceLoader = createMinimalResourceLoader();

      let resourceToolCalls = 0;
      let turns = 0;
      let budgetReached = false;
      const guardedTools = (request.accessMode === "SEALED" ? [] : gateway.tools)
        .filter((tool) => request.skill.allowedTools.includes(tool.name as never))
        .filter((tool) => {
          const operation = resourceOperationForTool(tool.name);
          return operation !== undefined && request.skill.resourcePolicy.allowedOperations.includes(operation);
        })
        .map((tool) => guardResourceTool(tool, () => {
          resourceToolCalls += 1;
          request.onTrace?.("tool_attempt", { tool: tool.name, ordinal: resourceToolCalls });
          if (resourceToolCalls > request.budget.maxToolCalls) {
            budgetReached = true;
            void childAbort?.();
            throw new ScopeBudgetError(`Resource tool-call budget exceeded (${request.budget.maxToolCalls})`);
          }
        }));
      const childSkillTool = request.invokeChild
        ? createChildSkillTool(request, childResults)
        : undefined;
      const customTools = [...guardedTools, ...(childSkillTool ? [childSkillTool] : []), completion.tool];
      const activeToolNames = customTools.map((tool) => tool.name);

      const sessionPromise = (this.options.createSession ?? createAgentSession)({
        cwd: request.cwd,
        model: host.model,
        thinkingLevel: host.thinkingLevel,
        modelRuntime,
        noTools: "all",
        tools: activeToolNames,
        customTools,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(request.cwd),
      });
      const { session } = await raceAgainstAbort(sessionPromise, lifecycle.signal, ({ session: lateSession }) => {
        void lateSession.abort();
        lateSession.dispose();
      });
      childAbort = () => session.abort();
      childDispose = () => session.dispose();
      if (lifecycle.signal.aborted) {
        await session.abort();
        session.dispose();
        childAbort = undefined;
        childDispose = undefined;
        throwIfAborted(lifecycle.signal);
      }

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end") {
          recordCompletionBatchPolicy(event.message, completionBatchDecisions, request.onTrace);
        } else if (event.type === "turn_start") {
          turns += 1;
          request.onTrace?.("turn_start", { ordinal: turns });
          if (turns > request.budget.maxTurns) {
            budgetReached = true;
            void session.abort();
          }
        } else if (event.type === "tool_execution_start") {
          const safeEvent = event as unknown as Record<string, unknown>;
          request.onTrace?.("tool_start", {
            tool: safeEvent.toolName ?? safeEvent.name,
            toolCallId: safeEvent.toolCallId,
          });
        } else if (event.type === "tool_execution_end") {
          const safeEvent = event as unknown as Record<string, unknown>;
          request.onTrace?.("tool_end", {
            tool: safeEvent.toolName ?? safeEvent.name,
            toolCallId: safeEvent.toolCallId,
            isError: safeEvent.isError,
          });
        }
      });

      let caught: Error | undefined;
      try {
        request.onProgress?.(`Running child session with ${guardedTools.length} scoped resource tool(s)`);
        await raceAgainstAbort(
          session.prompt(childPrompt, { expandPromptTemplates: false }),
          lifecycle.signal,
        );
      } catch (error) {
        caught = error instanceof Error ? error : new Error(String(error));
      } finally {
        unsubscribe();
      }

      const stats = session.getSessionStats();
      session.dispose();
      childAbort = undefined;
      childDispose = undefined;
      const usage = usageFromStats(stats, turns, resourceToolCalls);
      const resourceAudit = gateway.snapshot();

      if (parentSignal?.aborted) return { usage, resourceAudit, childResults, terminationReason: "cancelled", error: abortError(parentSignal) };
      if (timeoutReached) return { usage, resourceAudit, childResults, terminationReason: "timeout", error: new ScopeTimeoutError("Scoped skill timed out") };
      if (budgetReached) return { usage, resourceAudit, childResults, terminationReason: "budget", error: caught ?? new ScopeBudgetError("Scoped skill budget exceeded") };
      const protocolIssue = completion.getProtocolIssue();
      if (protocolIssue) return { usage, resourceAudit, childResults, protocolIssue, terminationReason: "completed" };
      const acceptedCompletion = completion.getCompletion();
      if (acceptedCompletion) {
        return { completion: acceptedCompletion, usage, resourceAudit, completionResourceAudit, childResults, terminationReason: "completed" };
      }
      if (caught) return { usage, resourceAudit, childResults, terminationReason: "failed", error: caught };
      return { usage, resourceAudit, childResults, terminationReason: "completed" };
    } catch (error) {
      if (parentSignal?.aborted) return failure("cancelled", abortError(parentSignal));
      if (timeoutReached) return failure("timeout", new ScopeTimeoutError("Scoped skill timed out"));
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
      void childAbort?.();
      childDispose?.();
    }
  }
}

/**
 * Pi's ExtensionContext intentionally does not expose the parent's
 * ModelRuntime. We reconstruct a child runtime from public ModelRegistry APIs,
 * keep credentials in memory, and never emit resolved secrets to Trace.
 */
export async function createEphemeralChildModelRuntime(host: PiInvocationHost): Promise<ModelRuntime> {
  if (!host.model) throw new Error("Cannot build a child ModelRuntime without a selected parent model");
  const providerId = host.model.provider;
  if (host.model.api !== "openai-completions") {
    throw new Error(`SkillScope v0.1 supports only API-key OpenAI-compatible chat-completions providers; received ${host.model.api}`);
  }
  if (host.modelRegistry.isUsingOAuth(host.model)) {
    throw new Error(`SkillScope v0.1 does not bridge OAuth authentication for child provider ${providerId}`);
  }
  const resolvedAuth = await host.modelRegistry.getApiKeyAndHeaders(host.model);
  if (!resolvedAuth.ok || !resolvedAuth.apiKey) {
    // Never let the fresh runtime silently fall back to its own ambient env.
    throw new Error(`Parent session did not provide explicit API-key authentication for child provider ${providerId}`);
  }
  const credentials = new EphemeralCredentialStore();
  await credentials.modify(providerId, async () => ({
    type: "api_key",
    key: resolvedAuth.apiKey,
    env: resolvedAuth.env,
  }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, signal: host.signal });
  const providerConfig = host.modelRegistry.getRegisteredProviderConfig(providerId);
  const nativeProvider = host.modelRegistry.getRegisteredNativeProvider(providerId);
  if (nativeProvider || providerConfig?.streamSimple) {
    throw new Error(`SkillScope v0.1 does not clone custom native stream providers: ${providerId}`);
  }
  const parentProvider = host.modelRegistry.getProvider(providerId);
  const headers = mergeProviderHeaders(providerConfig?.headers, host.model.headers, resolvedAuth.headers);
  const models = upsertModelDefinition(providerConfig?.models ?? [], host.model, resolvedAuth.baseUrl, headers);
  runtime.registerProvider(providerId, {
    ...(providerConfig ?? {}),
    name: providerConfig?.name ?? parentProvider?.name ?? providerId,
    api: providerConfig?.api ?? host.model.api,
    baseUrl: resolvedAuth.baseUrl ?? providerConfig?.baseUrl ?? parentProvider?.baseUrl ?? host.model.baseUrl,
    apiKey: resolvedAuth.apiKey,
    headers: Object.keys(headers).length === 0 ? undefined : headers,
    // The bridge is a frozen API-key snapshot, not a second OAuth or dynamic
    // catalog lifecycle inside the child session.
    oauth: undefined,
    refreshModels: undefined,
    models,
  });

  // Deliberately keep secrets local and never include them in errors or Trace.
  // Pi 0.84.2 keeps an availability snapshot; registration and runtime-key
  // credential/provider mutation do not synchronously refresh it.
  const refreshed = await runtime.refresh({ providers: [providerId], allowNetwork: false, signal: host.signal });
  const refreshError = refreshed.errors.get(providerId);
  if (refreshError) throw new Error(`Could not refresh child provider ${providerId}: ${refreshError.message}`);
  if (!runtime.hasConfiguredAuth(providerId)) {
    throw new Error(`No reusable authentication is configured for child provider ${providerId}`);
  }
  const childAuth = await runtime.getAuth(host.model, { signal: host.signal });
  if (!childAuth?.auth.apiKey || childAuth.auth.apiKey !== resolvedAuth.apiKey) {
    throw new Error(`Child provider ${providerId} did not retain the explicit parent authentication snapshot`);
  }
  return runtime;
}

function upsertModelDefinition(
  configured: ProviderModelDefinitions,
  model: NonNullable<PiInvocationHost["model"]>,
  resolvedBaseUrl?: string,
  effectiveHeaders?: Record<string, string>,
): ProviderModelDefinitions {
  const definition = {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: resolvedBaseUrl ?? model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    samplingParams: model.samplingParams === undefined ? undefined : { ...model.samplingParams },
    headers: effectiveHeaders && Object.keys(effectiveHeaders).length > 0 ? { ...effectiveHeaders } : undefined,
    compat: model.compat,
  };
  return [...configured.filter((candidate) => candidate.id !== model.id), definition];
}

function mergeProviderHeaders(
  ...sources: Array<Record<string, string | null> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) for (const [name, value] of Object.entries(source ?? {})) {
    const priorName = Object.keys(result).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (priorName) delete result[priorName];
    if (value !== null) result[name] = value;
  }
  return result;
}

class EphemeralCredentialStore {
  private readonly credentials = new Map<string, any>();
  private readonly chains = new Map<string, Promise<unknown>>();

  async read(providerId: string): Promise<any | undefined> {
    return this.credentials.get(providerId);
  }

  async list(): Promise<Array<{ providerId: string; type: "api_key" | "oauth" }>> {
    return [...this.credentials.entries()].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(providerId: string, fn: (current: any | undefined) => Promise<any | undefined>): Promise<any | undefined> {
    const prior = this.chains.get(providerId) ?? Promise.resolve();
    let result: any | undefined;
    const next = prior.then(async () => {
      const candidate = await fn(this.credentials.get(providerId));
      if (candidate !== undefined) this.credentials.set(providerId, candidate);
      result = this.credentials.get(providerId);
    });
    this.chains.set(providerId, next);
    await next;
    if (this.chains.get(providerId) === next) this.chains.delete(providerId);
    return result;
  }

  async delete(providerId: string): Promise<void> {
    this.credentials.delete(providerId);
  }
}

function createMinimalResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => [
      "You are a scoped read-only worker in a fresh Pi AgentSession.",
      "Follow the supplied skill instructions and resource grants.",
      "Only scope_* tools may inspect resources. End by calling scope_complete.",
    ].join("\n"),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function createChildSkillTool(request: ScopeBackendRequest, childResults: SkillResult[]): ToolDefinition {
  const operationSchema = Type.Union([Type.Literal("read"), Type.Literal("list"), Type.Literal("search")]);
  const promptRefSchema = Type.Union([
    Type.Object({
      kind: Type.Literal("inline"),
      name: Type.String({ minLength: 1, maxLength: 128 }),
      content: Type.String({ maxLength: 262_144 }),
    }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal("file"),
      name: Type.String({ minLength: 1, maxLength: 128 }),
      path: Type.String({ minLength: 1, maxLength: 2_048 }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false }),
  ]);
  const schema = Type.Object({
    skill: Type.String({ minLength: 1, maxLength: 64 }),
    input: Type.Unknown(),
    promptRefs: Type.Optional(Type.Array(promptRefSchema, { maxItems: 64 })),
    resourceGrants: Type.Optional(Type.Array(Type.Object({
      path: Type.String({ minLength: 1, maxLength: 2_048 }),
      kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
      operations: Type.Array(operationSchema, { minItems: 1, maxItems: 3 }),
    }, { additionalProperties: false }), { maxItems: 128 })),
    accessMode: Type.Optional(Type.Union([Type.Literal("SEALED"), Type.Literal("BOUNDED"), Type.Literal("PROJECT")])),
    budgetOverride: Type.Optional(Type.Object({
      maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
      maxToolCalls: Type.Optional(Type.Integer({ minimum: 1 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      maxPromptBytes: Type.Optional(Type.Integer({ minimum: 1 })),
      maxResultBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false })),
  }, { additionalProperties: false });

  return defineTool({
    name: "scope_invoke_skill",
    label: "Invoke child scoped skill",
    description: "Start one allowed child Skill in a fresh disposable Scope and return only its Runtime-validated structured result.",
    promptSnippet: "Delegate one typed subtask to a fresh child Scope",
    promptGuidelines: [
      `Only these child Skills are allowed: ${request.skill.delegationPolicy.allowedSkills.join(", ")}.`,
      "Each call creates a new Session; child messages and tool history are not inherited or returned.",
      "Pass the smallest input and a resource-grant subset of this Scope. Use the returned scope:// ID as evidence when aggregating.",
    ],
    executionMode: "parallel",
    parameters: schema,
    async execute(_toolCallId, params, signal, onUpdate) {
      request.onTrace?.("child_tool_attempt", { skill: params.skill, ordinal: childResults.length + 1 });
      onUpdate?.({ content: [{ type: "text", text: `Starting child Skill ${params.skill}…` }], details: undefined });
      const result = await request.invokeChild?.(params as SkillInvocation, signal ?? request.signal);
      if (!result) throw new Error("Child Scope invocation is unavailable");
      childResults.push(result);
      const compact = projectSkillResultForCaller(result);
      return {
        content: [{ type: "text", text: JSON.stringify(compact) }],
        details: result,
      };
    },
  });
}

function projectSkillResultForCaller(result: SkillResult): Record<string, unknown> {
  return {
    status: result.status,
    summary: result.summary,
    data: result.data,
    evidenceRefs: result.evidenceRefs,
    requestedResources: result.requestedResources,
    warnings: result.warnings,
    error: result.error,
    scopeId: result.scopeId,
    skill: result.skill,
  };
}

function guardResourceTool(tool: ToolDefinition, beforeExecute: () => void): ToolDefinition {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      beforeExecute();
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

function resourceOperationForTool(toolName: string): ResourceOperation | undefined {
  if (toolName === "scope_read") return "read";
  if (toolName === "scope_list") return "list";
  if (toolName === "scope_search") return "search";
  return undefined;
}

function recordCompletionBatchPolicy(
  message: unknown,
  decisions: Map<string, CompletionAttemptDecision>,
  onTrace?: (type: string, data?: unknown) => void,
): void {
  if (!message || typeof message !== "object") return;
  const candidate = message as Record<string, unknown>;
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return;
  const calls = candidate.content.flatMap((part): Array<{ id: string; name: string }> => {
    if (!part || typeof part !== "object") return [];
    const call = part as Record<string, unknown>;
    if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") return [];
    return [{ id: call.id, name: call.name }];
  });
  const completionCalls = calls.filter((call) => call.name === "scope_complete");
  if (completionCalls.length === 0 || calls.length === 1) return;

  const duplicate = completionCalls.length > 1;
  const decision: CompletionAttemptDecision = {
    accept: false,
    code: duplicate ? "DUPLICATE_COMPLETION" : "COMPLETION_HAS_SIBLING_TOOL",
    message: duplicate
      ? "An assistant message may contain exactly one scope_complete call"
      : "scope_complete must be the only tool call in its assistant message; observe sibling tool results in a later model turn first",
    fatal: duplicate,
  };
  for (const call of completionCalls) decisions.set(call.id, decision);
  onTrace?.("completion_batch_rejected", {
    code: decision.code,
    completionCalls: completionCalls.length,
    siblingCalls: calls.length - completionCalls.length,
    fatal: decision.fatal === true,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Scoped skill lifecycle aborted");
}

async function raceAgainstAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    void operation.then((value) => disposeLate?.(value), () => {});
    throwIfAborted(signal);
  }
  let delivered = false;
  const guardedOperation = operation.then((value) => {
    if (signal.aborted) {
      disposeLate?.(value);
      throw signal.reason instanceof Error ? signal.reason : new Error("Scoped skill lifecycle aborted");
    }
    delivered = true;
    return value;
  });
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Scoped skill lifecycle aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([guardedOperation, aborted]);
  } finally {
    removeAbortListener?.();
    if (!delivered && disposeLate) void guardedOperation.catch(() => {});
  }
}

function usageFromStats(
  stats: ReturnType<import("@earendil-works/pi-coding-agent").AgentSession["getSessionStats"]>,
  turns: number,
  toolCalls: number,
): Omit<ScopeUsage, "wallTimeMs"> {
  return {
    turns,
    toolCalls,
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    cost: stats.cost,
  };
}

function asPiHost(value: unknown): PiInvocationHost {
  if (!value || typeof value !== "object" || !("modelRegistry" in value)) {
    throw new Error("Pi backend requires model, modelRegistry, and thinkingLevel from the parent ExtensionContext");
  }
  return value as PiInvocationHost;
}

function failure(
  terminationReason: NonNullable<ScopeBackendResult["terminationReason"]>,
  error: Error,
  resourceAudit?: ScopeBackendResult["resourceAudit"],
): ScopeBackendResult {
  return {
    usage: { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
    terminationReason,
    error,
    resourceAudit,
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Scoped skill cancelled by parent");
}

class ScopeBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeBudgetError";
  }
}

class ScopeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeTimeoutError";
  }
}
