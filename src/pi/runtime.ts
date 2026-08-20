import { randomUUID } from "node:crypto";
import { TextEncoder } from "node:util";
import type {
  ChildScopeSummary,
  CompletionPayload,
  LoadedSkill,
  PromptRef,
  ResourceGrant,
  ScopeBackend,
  ScopeBackendResult,
  ScopeRuntimeContext,
  ScopeTreeUsage,
  ScopeUsage,
  SkillBudget,
  SkillInvocation,
  SkillResult,
  SkillStatus,
} from "./contracts.js";
import { validateJsonSchema } from "./json-schema.js";
import { SkillRegistry, SkillRegistryError } from "./skill-registry.js";
import { ScopeTrace, TraceStore } from "./trace-store.js";

const encoder = new TextEncoder();
const EMPTY_USAGE: Omit<ScopeUsage, "wallTimeMs"> = {
  turns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  cost: 0,
};

export interface ScopeRuntimeOptions {
  registry: SkillRegistry;
  backend: ScopeBackend;
  traceStore: TraceStore;
  now?: () => Date;
  id?: () => string;
  /** Root is depth 0; v1 defaults to one child level. */
  maxScopeDepth?: number;
}

export interface ScopeLifecycleSnapshot {
  activeScopeIds: string[];
  startedScopes: number;
  disposedScopes: number;
}

export class SkillScopeRuntime {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly maxScopeDepth: number;
  private readonly options: ScopeRuntimeOptions;
  private readonly activeScopeIds = new Set<string>();
  private startedScopes = 0;
  private disposedScopes = 0;

  constructor(options: ScopeRuntimeOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.maxScopeDepth = options.maxScopeDepth ?? 1;
    if (!Number.isSafeInteger(this.maxScopeDepth) || this.maxScopeDepth < 0) {
      throw new Error("maxScopeDepth must be a non-negative integer");
    }
  }

  getLifecycleSnapshot(): ScopeLifecycleSnapshot {
    return {
      activeScopeIds: [...this.activeScopeIds].sort(),
      startedScopes: this.startedScopes,
      disposedScopes: this.disposedScopes,
    };
  }

  async invoke(invocation: SkillInvocation, context: ScopeRuntimeContext): Promise<SkillResult> {
    const invocationId = this.id();
    const scopeId = this.id();
    const depth = context.depth ?? 0;
    const rootScopeId = context.rootScopeId ?? scopeId;
    const startedAtDate = this.now();
    const startedAt = startedAtDate.toISOString();
    let skill: LoadedSkill | undefined;
    let trace: ScopeTrace | undefined;

    this.activeScopeIds.add(scopeId);
    this.startedScopes += 1;

    try {
      if (!Number.isSafeInteger(depth) || depth < 0 || depth > this.maxScopeDepth) {
        throw new SkillRegistryError("SCOPE_DEPTH_EXCEEDED", `Scope depth ${depth} exceeds Runtime limit ${this.maxScopeDepth}`);
      }
      skill = await this.options.registry.load(invocation.skill);
      const accessMode = invocation.accessMode ?? skill.resourcePolicy.defaultAccessMode;
      const budget = mergeBudget(skill.budget, invocation.budgetOverride);
      trace = await this.options.traceStore.begin(scopeId, context.cwd, {
        schemaVersion: "1.1",
        scopeId,
        invocationId,
        parentSessionId: context.parentSessionId,
        parentScopeId: context.parentScopeId,
        rootScopeId,
        depth,
        requestedSkill: invocation.skill,
        requestedAccessMode: invocation.accessMode,
        accessMode,
        budget,
        input: invocation.input,
        promptRefs: summarizePromptRefs(invocation.promptRefs ?? []),
        resourceGrants: invocation.resourceGrants ?? [],
        delegationPolicy: skill.delegationPolicy,
        startedAt,
      });
      trace.event("scope_started");
      trace.event("skill_loaded", { name: skill.name, version: skill.version });

      const inputIssues = validateJsonSchema(skill.inputSchema, invocation.input);
      if (inputIssues.length > 0) {
        return await this.finish(trace, this.makeFailure({
          scopeId,
          invocationId,
          context,
          skill,
          startedAt,
          status: "INVALID_INPUT",
          code: "INVALID_INPUT",
          message: inputIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
          startedAtDate,
        }));
      }

      if (!skill.resourcePolicy.allowedAccessModes.includes(accessMode)) {
        return await this.finish(trace, this.makeFailure({
          scopeId, invocationId, context, skill, startedAt, startedAtDate,
          status: "INVALID_INPUT", code: "ACCESS_MODE_NOT_ALLOWED",
          message: `${accessMode} is not allowed by skill ${skill.name}`,
        }));
      }

      const resourceGrants = invocation.resourceGrants ?? [];
      const grantError = validateGrants(resourceGrants, skill);
      if (grantError) {
        return await this.finish(trace, this.makeFailure({
          scopeId, invocationId, context, skill, startedAt, startedAtDate,
          status: "INVALID_INPUT", code: "INVALID_RESOURCE_GRANT", message: grantError,
        }));
      }

      const promptRefBytes = encoder.encode(JSON.stringify(invocation.promptRefs ?? [])).byteLength;
      if (promptRefBytes > budget.maxPromptBytes) {
        return await this.finish(trace, this.makeFailure({
          scopeId, invocationId, context, skill, startedAt, startedAtDate,
          status: "INVALID_INPUT", code: "PROMPT_REFS_TOO_LARGE",
          message: `Serialized promptRefs use ${promptRefBytes} bytes; limit is ${budget.maxPromptBytes}`,
        }));
      }

      context.onProgress?.(`Starting scoped skill ${skill.name}@${skill.version}`);
      const childController = this.createChildController({
        parentContext: context,
        parentSkill: skill,
        parentScopeId: scopeId,
        rootScopeId,
        depth,
        effectiveAccessMode: accessMode,
        effectiveGrants: resourceGrants,
        trace,
      });
      const backendResult = await this.options.backend.run({
        scopeId,
        invocationId,
        cwd: context.cwd,
        skill,
        input: invocation.input,
        promptRefs: invocation.promptRefs ?? [],
        resourceGrants,
        accessMode,
        budget,
        invokeChild: childController.invokeChild,
        signal: context.signal,
        hostContext: context.hostContext,
        onProgress: context.onProgress,
        onTrace: (type, data) => trace?.event(type, data),
      });

      const result = this.wrapBackendResult({
        backendResult,
        scopeId,
        invocationId,
        context,
        skill,
        startedAt,
        startedAtDate,
        budget,
        promptRefs: invocation.promptRefs ?? [],
      });
      return await this.finish(trace, result);
    } catch (error) {
      const status: SkillStatus = context.signal?.aborted
        ? "CANCELLED"
        : error instanceof SkillRegistryError
          ? "INVALID_INPUT"
          : "FAILED";
      const code = error instanceof SkillRegistryError ? error.code : status;
      const fallbackSkill = skill ?? fallbackLoadedSkill(invocation.skill);
      const result = this.makeFailure({
        scopeId,
        invocationId,
        context,
        skill: fallbackSkill,
        startedAt,
        startedAtDate,
        status,
        code,
        message: error instanceof Error ? error.message : String(error),
      });
      if (trace) return await this.finish(trace, result);
      return result;
    } finally {
      this.activeScopeIds.delete(scopeId);
      this.disposedScopes += 1;
    }
  }

  private createChildController(args: {
    parentContext: ScopeRuntimeContext;
    parentSkill: LoadedSkill;
    parentScopeId: string;
    rootScopeId: string;
    depth: number;
    effectiveAccessMode: LoadedSkill["resourcePolicy"]["defaultAccessMode"];
    effectiveGrants: ResourceGrant[];
    trace: ScopeTrace;
  }): { invokeChild?: NonNullable<import("./contracts.js").ScopeBackendRequest["invokeChild"]> } {
    const policy = args.parentSkill.delegationPolicy;
    if (policy.allowedSkills.length === 0 || args.depth >= this.maxScopeDepth) return {};
    let started = 0;
    let active = 0;

    return {
      invokeChild: async (invocation, signal) => {
        if (!policy.allowedSkills.includes(invocation.skill)) {
          throw new SkillRegistryError("CHILD_SKILL_NOT_ALLOWED", `${args.parentSkill.name} cannot invoke child skill ${invocation.skill}`);
        }
        if (started >= policy.maxChildScopes) {
          throw new SkillRegistryError("CHILD_SCOPE_LIMIT", `${args.parentSkill.name} exceeded ${policy.maxChildScopes} child Scope(s)`);
        }
        if (active >= policy.maxConcurrency) {
          throw new SkillRegistryError("CHILD_CONCURRENCY_LIMIT", `${args.parentSkill.name} exceeded child concurrency ${policy.maxConcurrency}`);
        }
        // Reserve the concurrency slot before the first await. Otherwise two
        // sibling tool calls can both observe the same free slot and race.
        active += 1;
        try {
          const childSkill = await this.options.registry.load(invocation.skill);
          const childAccessMode = invocation.accessMode ?? childSkill.resourcePolicy.defaultAccessMode;
          const childGrants = invocation.resourceGrants ?? [];
          validateChildEnvelope({
            parentAccessMode: args.effectiveAccessMode,
            parentGrants: args.effectiveGrants,
            childAccessMode,
            childGrants,
            childPromptRefs: invocation.promptRefs ?? [],
          });
          if (started >= policy.maxChildScopes) {
            throw new SkillRegistryError("CHILD_SCOPE_LIMIT", `${args.parentSkill.name} exceeded ${policy.maxChildScopes} child Scope(s)`);
          }
          started += 1;
          const ordinal = started;
          args.trace.event("child_scope_started", { ordinal, skill: invocation.skill, depth: args.depth + 1 });
          const result = await this.invoke(invocation, {
            cwd: args.parentContext.cwd,
            parentSessionId: args.parentContext.parentSessionId,
            parentScopeId: args.parentScopeId,
            rootScopeId: args.rootScopeId,
            depth: args.depth + 1,
            signal: signal ?? args.parentContext.signal,
            hostContext: args.parentContext.hostContext,
            onProgress: args.parentContext.onProgress
              ? (message) => args.parentContext.onProgress?.(`[child ${ordinal}:${invocation.skill}] ${message}`)
              : undefined,
          });
          args.trace.event("child_scope_finished", {
            ordinal,
            skill: invocation.skill,
            depth: result.depth,
            status: result.status,
            scopeId: result.scopeId,
            usage: result.treeUsage,
          });
          return result;
        } finally {
          active -= 1;
        }
      },
    };
  }

  async dispose(): Promise<void> {
    await this.options.backend.dispose?.();
  }

  private wrapBackendResult(args: {
    backendResult: ScopeBackendResult;
    scopeId: string;
    invocationId: string;
    context: ScopeRuntimeContext;
    skill: LoadedSkill;
    startedAt: string;
    startedAtDate: Date;
    budget: SkillBudget;
    promptRefs: PromptRef[];
  }): SkillResult {
    const { backendResult, budget } = args;
    if (backendResult.terminationReason && backendResult.terminationReason !== "completed") {
      const status = terminationStatus(backendResult.terminationReason);
      return this.makeFailure({
        ...args,
        status,
        code: status,
        message: backendResult.error?.message ?? terminationMessage(backendResult.terminationReason),
        usage: backendResult.usage,
        resourceAudit: backendResult.resourceAudit,
        childResults: backendResult.childResults,
      });
    }
    if (backendResult.error) {
      return this.makeFailure({
        ...args,
        status: "FAILED",
        code: "FAILED",
        message: backendResult.error.message,
        usage: backendResult.usage,
        resourceAudit: backendResult.resourceAudit,
        childResults: backendResult.childResults,
      });
    }
    if (backendResult.protocolIssue) {
      return this.makeFailure({
        ...args,
        status: "INVALID_RESULT",
        code: backendResult.protocolIssue.code,
        message: backendResult.protocolIssue.message,
        usage: backendResult.usage,
        resourceAudit: backendResult.resourceAudit,
        childResults: backendResult.childResults,
      });
    }
    if (!backendResult.completion) {
      return this.makeFailure({
        ...args,
        status: "INVALID_RESULT",
        code: "MISSING_COMPLETION",
        message: "Child session ended without calling scope_complete",
        usage: backendResult.usage,
        resourceAudit: backendResult.resourceAudit,
        childResults: backendResult.childResults,
      });
    }

    const completion = bindChildEvidence(backendResult.completion, args.skill, backendResult.childResults);
    const encodedBytes = encoder.encode(JSON.stringify(completion)).byteLength;
    const completionIssues = validateCompletionPayload(completion);
    const dataRequired = completion.status === "SUCCESS" || completion.status === "PARTIAL";
    const outputIssues = completion.data === undefined
      ? dataRequired ? [{ path: "$.data", message: `is required for ${completion.status}` }] : []
      : validateJsonSchema(args.skill.outputSchema, completion.data);
    const evidenceIssues = validateEvidenceRefs(
      completion.evidenceRefs,
      args.promptRefs,
      backendResult.completionResourceAudit,
      backendResult.childResults,
    );
    const requestedResourceIssues = validateRequestedResources(completion, args.skill);
    const evidenceIdIssues = validateEvidenceIdReferences(completion.data, completion.evidenceRefs);
    if (
      encodedBytes > budget.maxResultBytes
      || completionIssues.length > 0
      || outputIssues.length > 0
      || evidenceIssues.length > 0
      || requestedResourceIssues.length > 0
      || evidenceIdIssues.length > 0
    ) {
      return this.makeFailure({
        ...args,
        status: "INVALID_RESULT",
        code: encodedBytes > budget.maxResultBytes
          ? "RESULT_TOO_LARGE"
          : completionIssues.length > 0
            ? "COMPLETION_SCHEMA_INVALID"
            : outputIssues.length > 0
              ? "OUTPUT_SCHEMA_INVALID"
              : evidenceIssues.length > 0
                ? "EVIDENCE_NOT_VISIBLE"
                : requestedResourceIssues.length > 0
                  ? "REQUESTED_RESOURCE_INVALID"
                  : "EVIDENCE_ID_NOT_FOUND",
        message: encodedBytes > budget.maxResultBytes
          ? `CompletionPayload uses ${encodedBytes} bytes; limit is ${budget.maxResultBytes}`
          : completionIssues.length > 0
            ? completionIssues.join("; ")
            : outputIssues.length > 0
              ? outputIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
              : evidenceIssues.length > 0
                ? evidenceIssues.join("; ")
                : requestedResourceIssues.length > 0
                  ? requestedResourceIssues.join("; ")
                  : evidenceIdIssues.join("; "),
        usage: backendResult.usage,
        resourceAudit: backendResult.resourceAudit,
        childResults: backendResult.childResults,
      });
    }

    const endedAtDate = this.now();
    const usage = { ...backendResult.usage, wallTimeMs: elapsed(args.startedAtDate, endedAtDate) };
    const childScopes = summarizeChildScopes(backendResult.childResults);
    return {
      schemaVersion: "1.1",
      scopeId: args.scopeId,
      invocationId: args.invocationId,
      parentSessionId: args.context.parentSessionId,
      ...(args.context.parentScopeId ? { parentScopeId: args.context.parentScopeId } : {}),
      rootScopeId: args.context.rootScopeId ?? args.scopeId,
      depth: args.context.depth ?? 0,
      skill: { name: args.skill.name, version: args.skill.version },
      status: completion.status,
      summary: completion.summary,
      data: completion.data,
      evidenceRefs: completion.evidenceRefs,
      requestedResources: completion.requestedResources ?? [],
      warnings: completion.warnings ?? [],
      usage,
      treeUsage: calculateTreeUsage(usage, backendResult.childResults),
      childScopes,
      traceId: args.scopeId,
      startedAt: args.startedAt,
      endedAt: endedAtDate.toISOString(),
      resourceAudit: backendResult.resourceAudit,
    };
  }

  private makeFailure(args: {
    scopeId: string;
    invocationId: string;
    context: ScopeRuntimeContext;
    skill: LoadedSkill;
    startedAt: string;
    startedAtDate: Date;
    status: SkillStatus;
    code: string;
    message: string;
    usage?: Omit<ScopeUsage, "wallTimeMs">;
    resourceAudit?: ScopeBackendResult["resourceAudit"];
    childResults?: SkillResult[];
  }): SkillResult {
    const endedAtDate = this.now();
    const usage = { ...(args.usage ?? EMPTY_USAGE), wallTimeMs: elapsed(args.startedAtDate, endedAtDate) };
    return {
      schemaVersion: "1.1",
      scopeId: args.scopeId,
      invocationId: args.invocationId,
      parentSessionId: args.context.parentSessionId,
      ...(args.context.parentScopeId ? { parentScopeId: args.context.parentScopeId } : {}),
      rootScopeId: args.context.rootScopeId ?? args.scopeId,
      depth: args.context.depth ?? 0,
      skill: { name: args.skill.name, version: args.skill.version },
      status: args.status,
      summary: args.message,
      evidenceRefs: [],
      requestedResources: [],
      warnings: [],
      error: { code: args.code, message: args.message, retryable: isRetryable(args.status) },
      usage,
      treeUsage: calculateTreeUsage(usage, args.childResults),
      childScopes: summarizeChildScopes(args.childResults),
      traceId: args.scopeId,
      startedAt: args.startedAt,
      endedAt: endedAtDate.toISOString(),
      resourceAudit: args.resourceAudit,
    };
  }

  private async finish(trace: ScopeTrace, result: SkillResult): Promise<SkillResult> {
    trace.event("scope_finished", { status: result.status, usage: result.usage });
    try {
      await trace.finish(result);
      return result;
    } catch (error) {
      return {
        ...result,
        warnings: [...result.warnings, `Trace persistence failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }
}

function mergeBudget(limit: SkillBudget, override?: Partial<SkillBudget>): SkillBudget {
  if (!override) return { ...limit };
  const result = { ...limit };
  for (const key of Object.keys(limit) as Array<keyof SkillBudget>) {
    const value = override[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`budgetOverride.${key} must be a positive integer`);
    result[key] = Math.min(limit[key], value);
  }
  return result;
}

function validateGrants(grants: ResourceGrant[], skill: LoadedSkill): string | undefined {
  for (const grant of grants) {
    if (grant.path.length === 0) return "Resource grant path must not be empty";
    if (grant.kind === "file" && grant.operations.includes("list")) return `File grant ${grant.path} cannot include list`;
    for (const operation of grant.operations) {
      if (!skill.resourcePolicy.allowedOperations.includes(operation)) return `${operation} is not allowed by skill ${skill.name}`;
    }
  }
  return undefined;
}

function terminationStatus(reason: ScopeBackendResult["terminationReason"]): SkillStatus {
  if (reason === "timeout") return "TIMEOUT";
  if (reason === "budget") return "BUDGET_EXCEEDED";
  if (reason === "cancelled") return "CANCELLED";
  if (reason === "failed") return "FAILED";
  return "INVALID_RESULT";
}

function terminationMessage(reason: ScopeBackendResult["terminationReason"]): string {
  if (reason === "timeout") return "Scoped skill timed out";
  if (reason === "budget") return "Scoped skill budget was exceeded";
  if (reason === "cancelled") return "Scoped skill was cancelled";
  if (reason === "failed") return "Scoped skill backend failed";
  return "Child session ended without calling scope_complete";
}

function summarizePromptRefs(refs: NonNullable<SkillInvocation["promptRefs"]>): unknown[] {
  return refs.map((ref) => ref.kind === "inline"
    ? { kind: ref.kind, name: ref.name, bytes: encoder.encode(ref.content).byteLength }
    : { ...ref });
}

function fallbackLoadedSkill(name: string): LoadedSkill {
  return {
    name,
    version: "unknown",
    description: "unresolved scoped skill",
    promptFile: "",
    inputSchema: {},
    outputSchema: {},
    allowedTools: [],
    resourcePolicy: { defaultAccessMode: "SEALED", allowedAccessModes: ["SEALED"], allowedOperations: [] },
    delegationPolicy: { allowedSkills: [], maxChildScopes: 0, maxConcurrency: 1, childEvidenceBinding: "model" },
    budget: { maxTurns: 1, maxToolCalls: 1, timeoutMs: 1, maxPromptBytes: 1, maxResultBytes: 1 },
    directory: "",
    instructions: "",
  };
}

function elapsed(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

function isRetryable(status: SkillStatus): boolean {
  return status === "FAILED" || status === "TIMEOUT";
}

function calculateTreeUsage(usage: ScopeUsage, childResults: SkillResult[] = []): ScopeTreeUsage {
  const tree: ScopeTreeUsage = {
    scopes: 1,
    turns: usage.turns,
    toolCalls: usage.toolCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    cost: usage.cost,
  };
  for (const child of childResults) {
    tree.scopes += child.treeUsage.scopes;
    tree.turns += child.treeUsage.turns;
    tree.toolCalls += child.treeUsage.toolCalls;
    tree.inputTokens += child.treeUsage.inputTokens;
    tree.outputTokens += child.treeUsage.outputTokens;
    tree.cacheReadTokens += child.treeUsage.cacheReadTokens;
    tree.cacheWriteTokens += child.treeUsage.cacheWriteTokens;
    tree.totalTokens += child.treeUsage.totalTokens;
    tree.cost += child.treeUsage.cost;
  }
  return tree;
}

function summarizeChildScopes(childResults: SkillResult[] = []): ChildScopeSummary[] {
  return childResults.map((child) => ({
    scopeId: child.scopeId,
    invocationId: child.invocationId,
    parentScopeId: child.parentScopeId ?? "",
    rootScopeId: child.rootScopeId,
    depth: child.depth,
    skill: child.skill,
    status: child.status,
    resultBytes: encoder.encode(JSON.stringify(child)).byteLength,
    usage: child.usage,
    treeUsage: child.treeUsage,
    startedAt: child.startedAt,
    endedAt: child.endedAt,
  }));
}

function validateChildEnvelope(args: {
  parentAccessMode: LoadedSkill["resourcePolicy"]["defaultAccessMode"];
  parentGrants: ResourceGrant[];
  childAccessMode: LoadedSkill["resourcePolicy"]["defaultAccessMode"];
  childGrants: ResourceGrant[];
  childPromptRefs: PromptRef[];
}): void {
  const allowedModes = args.parentAccessMode === "PROJECT"
    ? new Set(["PROJECT", "BOUNDED", "SEALED"])
    : args.parentAccessMode === "BOUNDED"
      ? new Set(["BOUNDED", "SEALED"])
      : new Set(["SEALED"]);
  if (!allowedModes.has(args.childAccessMode)) {
    throw new SkillRegistryError(
      "CHILD_ACCESS_EXPANSION",
      `Child access mode ${args.childAccessMode} exceeds parent mode ${args.parentAccessMode}`,
    );
  }
  if (args.childAccessMode === "SEALED" && args.childGrants.length > 0) {
    throw new SkillRegistryError("CHILD_ACCESS_EXPANSION", "SEALED child Scope cannot receive exploration grants");
  }
  if (args.parentAccessMode !== "PROJECT") {
    for (const grant of args.childGrants) {
      if (!args.parentGrants.some((parent) => grantCoveredByParent(grant, parent))) {
        throw new SkillRegistryError("CHILD_GRANT_EXPANSION", `Child grant ${grant.path} exceeds the parent Scope envelope`);
      }
    }
    for (const ref of args.childPromptRefs) {
      if (ref.kind !== "file") continue;
      const required: ResourceGrant = { path: ref.path, kind: "file", operations: ["read"] };
      if (!args.parentGrants.some((parent) => grantCoveredByParent(required, parent))) {
        throw new SkillRegistryError("CHILD_GRANT_EXPANSION", `Child prompt ref ${ref.path} exceeds the parent Scope envelope`);
      }
    }
  }
}

function grantCoveredByParent(child: ResourceGrant, parent: ResourceGrant): boolean {
  const childPath = normalizeEnvelopePath(child.path);
  const parentPath = normalizeEnvelopePath(parent.path);
  if (childPath === undefined || parentPath === undefined) return false;
  const pathCovered = parent.kind === "file"
    ? child.kind === "file" && childPath === parentPath
    : parentPath === "." || childPath === parentPath || childPath.startsWith(`${parentPath}/`);
  return pathCovered && child.operations.every((operation) => parent.operations.includes(operation));
}

function normalizeEnvelopePath(path: string): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.includes("\\")) return undefined;
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return undefined;
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return undefined;
  return segments.length === 0 ? "." : segments.join("/");
}

function validateCompletionPayload(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["CompletionPayload must be an object"];
  const payload = value as Record<string, unknown>;
  const issues: string[] = [];
  const allowed = new Set(["status", "summary", "data", "evidenceRefs", "requestedResources", "warnings"]);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) issues.push(`$.${key} is not allowed`);
  if (!["SUCCESS", "PARTIAL", "NEED_CONTEXT", "BLOCKED"].includes(String(payload.status))) issues.push("$.status is invalid");
  if (typeof payload.summary !== "string" || payload.summary.length === 0) issues.push("$.summary must be a non-empty string");
  if (!Array.isArray(payload.evidenceRefs)) issues.push("$.evidenceRefs must be an array");
  else payload.evidenceRefs.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(`$.evidenceRefs[${index}] must be an object`);
      return;
    }
    const evidence = item as Record<string, unknown>;
    if (typeof evidence.id !== "string" || evidence.id.length === 0) issues.push(`$.evidenceRefs[${index}].id is required`);
    if (typeof evidence.resource !== "string" || evidence.resource.length === 0) issues.push(`$.evidenceRefs[${index}].resource is required`);
  });
  if (payload.requestedResources !== undefined && !Array.isArray(payload.requestedResources)) {
    issues.push("$.requestedResources must be an array");
  }
  if (payload.warnings !== undefined && (!Array.isArray(payload.warnings) || payload.warnings.some((warning) => typeof warning !== "string"))) {
    issues.push("$.warnings must be an array of strings");
  }
  return issues;
}

function validateEvidenceRefs(
  refs: CompletionPayload["evidenceRefs"],
  promptRefs: PromptRef[],
  completionAudit?: ScopeBackendResult["completionResourceAudit"],
  childResults?: SkillResult[],
): string[] {
  if (!Array.isArray(refs)) return [];
  const allowed = new Set<string>();
  for (const ref of promptRefs) {
    allowed.add(ref.name);
    if (ref.kind === "inline") allowed.add(`inline://${ref.name}`);
    else {
      const path = ref.path.split("\\").join("/").replace(/^\.\//, "");
      allowed.add(path);
      allowed.add(`file://${path}`);
      allowed.add(`file://${ref.name}`);
    }
  }
  const visible = completionAudit?.modelVisibleSet;
  if (Array.isArray(visible)) for (const item of visible) {
    if (typeof item !== "string") continue;
    allowed.add(item);
    allowed.add(`file://${item}`);
  }
  for (const child of childResults ?? []) {
    allowed.add(child.scopeId);
    allowed.add(`scope://${child.scopeId}`);
    allowed.add(`scope://${child.scopeId}/result`);
  }

  const issues: string[] = [];
  const ids = new Set<string>();
  refs.forEach((ref, index) => {
    if (!ref || typeof ref !== "object") return;
    if (typeof ref.id === "string") {
      if (ids.has(ref.id)) issues.push(`$.evidenceRefs[${index}].id duplicates ${ref.id}`);
      ids.add(ref.id);
    }
    if (typeof ref.resource !== "string") return;
    const resourceWithoutLocator = ref.resource.split("#", 1)[0];
    if (!allowed.has(ref.resource) && !allowed.has(resourceWithoutLocator)) {
      issues.push(`$.evidenceRefs[${index}].resource was not visible before scope_complete`);
    }
  });
  return issues;
}

function bindChildEvidence(
  completion: CompletionPayload,
  skill: LoadedSkill,
  childResults?: SkillResult[],
): CompletionPayload {
  if (skill.delegationPolicy.childEvidenceBinding !== "runtime") return completion;
  return {
    ...completion,
    evidenceRefs: (childResults ?? []).map((child, index) => ({
      id: `runtime-child-${index + 1}`,
      resource: `scope://${child.scopeId}`,
    })),
  };
}

function validateRequestedResources(completion: CompletionPayload, skill: LoadedSkill): string[] {
  if (completion.requestedResources !== undefined && !Array.isArray(completion.requestedResources)) return [];
  const requested = completion.requestedResources ?? [];
  const issues: string[] = [];
  if (completion.status === "NEED_CONTEXT" && requested.length === 0) {
    issues.push("$.requestedResources must be non-empty for NEED_CONTEXT");
  }
  if (completion.status !== "NEED_CONTEXT" && requested.length > 0) {
    issues.push(`$.requestedResources is not allowed for ${completion.status}`);
  }
  requested.forEach((item, index) => {
    const path = `$.requestedResources[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(`${path} must be an object`);
      return;
    }
    const candidate = item as unknown as Record<string, unknown>;
    for (const key of Object.keys(candidate)) {
      if (!new Set(["path", "operations", "reason"]).has(key)) issues.push(`${path}.${key} is not allowed`);
    }
    if (typeof candidate.path !== "string" || !isSafeRequestedPath(candidate.path)) {
      issues.push(`${path}.path must be a project-relative path without traversal, backslashes, drive prefixes, or NUL bytes`);
    }
    if (!Array.isArray(candidate.operations) || candidate.operations.length === 0) {
      issues.push(`${path}.operations must be a non-empty array`);
    } else {
      const seen = new Set<string>();
      candidate.operations.forEach((operation, operationIndex) => {
        if (typeof operation !== "string" || !skill.resourcePolicy.allowedOperations.includes(operation as never)) {
          issues.push(`${path}.operations[${operationIndex}] is not allowed by skill ${skill.name}`);
        } else if (seen.has(operation)) {
          issues.push(`${path}.operations[${operationIndex}] duplicates ${operation}`);
        }
        if (typeof operation === "string") seen.add(operation);
      });
    }
    if (typeof candidate.reason !== "string" || candidate.reason.length === 0) {
      issues.push(`${path}.reason must be a non-empty string`);
    }
  });
  return issues;
}

function isSafeRequestedPath(path: string): boolean {
  if (path.length === 0 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return false;
  return !path.split("/").some((segment) => segment === "..");
}

function validateEvidenceIdReferences(data: unknown, evidenceRefs: CompletionPayload["evidenceRefs"]): string[] {
  const knownIds = new Set(
    Array.isArray(evidenceRefs)
      ? evidenceRefs.flatMap((ref) => typeof ref?.id === "string" ? [ref.id] : [])
      : [],
  );
  const issues: string[] = [];
  const seen = new Set<object>();
  visit(data, "$.data");
  return issues;

  function visit(value: unknown, path: string): void {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (key === "evidenceIds" && Array.isArray(child)) {
        child.forEach((id, index) => {
          if (typeof id === "string" && !knownIds.has(id)) {
            issues.push(`${childPath}[${index}] references unknown evidence id ${id}`);
          }
        });
      }
      visit(child, childPath);
    }
  }
}
