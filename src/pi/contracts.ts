export type JsonSchema = Readonly<Record<string, unknown>>;

export type ResourceOperation = "read" | "list" | "search";
export type ScopeAccessMode = "SEALED" | "BOUNDED" | "PROJECT";

export interface InlinePromptRef {
  kind: "inline";
  name: string;
  content: string;
}

export interface FilePromptRef {
  kind: "file";
  name: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Prompt refs are materialized once before the child session starts. They are
 * deliberately separate from resource grants, which govern later exploration.
 */
export type PromptRef = InlinePromptRef | FilePromptRef;

export interface ResourceGrant {
  path: string;
  kind: "file" | "directory";
  operations: ResourceOperation[];
}

export interface SkillBudget {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxPromptBytes: number;
  maxResultBytes: number;
}

export interface SkillSpec {
  name: string;
  version: string;
  description: string;
  promptFile: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  allowedTools: Array<"scope_read" | "scope_list" | "scope_search">;
  resourcePolicy: {
    defaultAccessMode: ScopeAccessMode;
    allowedAccessModes: ScopeAccessMode[];
    allowedOperations: ResourceOperation[];
  };
  budget: SkillBudget;
}

export interface LoadedSkill extends SkillSpec {
  directory: string;
  instructions: string;
}

export interface SkillInvocation {
  skill: string;
  input: unknown;
  promptRefs?: PromptRef[];
  resourceGrants?: ResourceGrant[];
  accessMode?: ScopeAccessMode;
  budgetOverride?: Partial<SkillBudget>;
}

export interface EvidenceRef {
  /** Stable identifier used by data/findings to cite this evidence. */
  id: string;
  /** Granted project-relative resource path or prompt-ref name. */
  resource: string;
  locator?: string;
  claim?: string;
}

export interface RequestedResource {
  path: string;
  operations: ResourceOperation[];
  reason: string;
}

export type CompletionStatus = "SUCCESS" | "PARTIAL" | "NEED_CONTEXT" | "BLOCKED";

/**
 * The only payload the child model is allowed to submit. Runtime identity,
 * timing, usage, errors, trace ids, and skill versions intentionally do not
 * appear here and therefore cannot be forged by the model.
 */
export interface CompletionPayload<TData = unknown> {
  status: CompletionStatus;
  summary: string;
  data?: TData;
  evidenceRefs: EvidenceRef[];
  requestedResources?: RequestedResource[];
  warnings?: string[];
}

export type SkillStatus =
  | CompletionStatus
  | "INVALID_INPUT"
  | "INVALID_RESULT"
  | "FAILED"
  | "TIMEOUT"
  | "BUDGET_EXCEEDED"
  | "CANCELLED";

export interface ScopeUsage {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  wallTimeMs: number;
}

export interface ResourceAuditSnapshot {
  declared?: unknown;
  granted?: unknown;
  attempted?: unknown;
  actualRead?: unknown;
  modelVisible?: unknown;
  denials?: unknown;
  events?: unknown;
  [key: string]: unknown;
}

export interface SkillResult<TData = unknown> {
  schemaVersion: "1.0";
  scopeId: string;
  invocationId: string;
  parentSessionId: string;
  skill: { name: string; version: string };
  status: SkillStatus;
  summary: string;
  data?: TData;
  evidenceRefs: EvidenceRef[];
  requestedResources: RequestedResource[];
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean };
  usage: ScopeUsage;
  traceId: string;
  startedAt: string;
  endedAt: string;
  resourceAudit?: ResourceAuditSnapshot;
}

export interface ScopeBackendRequest {
  scopeId: string;
  invocationId: string;
  cwd: string;
  skill: LoadedSkill;
  input: unknown;
  promptRefs: PromptRef[];
  resourceGrants: ResourceGrant[];
  accessMode: ScopeAccessMode;
  budget: SkillBudget;
  signal?: AbortSignal;
  hostContext?: unknown;
  onProgress?: (message: string) => void;
  onTrace?: (type: string, data?: unknown) => void;
}

export interface ScopeBackendResult {
  completion?: CompletionPayload;
  usage: Omit<ScopeUsage, "wallTimeMs">;
  resourceAudit?: ResourceAuditSnapshot;
  /** Snapshot captured immediately before accepting scope_complete. */
  completionResourceAudit?: ResourceAuditSnapshot;
  protocolIssue?: { code: string; message: string };
  terminationReason?: "completed" | "timeout" | "budget" | "cancelled" | "failed";
  error?: Error;
}

export interface ScopeBackend {
  run(request: ScopeBackendRequest): Promise<ScopeBackendResult>;
  dispose?(): Promise<void> | void;
}

export interface ScopeRuntimeContext {
  cwd: string;
  parentSessionId: string;
  signal?: AbortSignal;
  hostContext?: unknown;
  onProgress?: (message: string) => void;
}
