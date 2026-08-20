import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { CompletionPayload, JsonSchema, SkillBudget } from "./contracts.js";

export interface CompletionToolHandle {
  tool: ToolDefinition;
  getCompletion(): CompletionPayload | undefined;
  getProtocolIssue(): CompletionProtocolIssue | undefined;
}

export interface CompletionProtocolIssue {
  code: string;
  message: string;
}

export interface CompletionAttemptDecision {
  accept: boolean;
  code?: string;
  message?: string;
  /** Fatal decisions make the whole scoped result invalid. */
  fatal?: boolean;
}

export interface CompletionToolOptions {
  beforeAccept?: (toolCallId: string, payload: CompletionPayload) => CompletionAttemptDecision;
  runtimeBindsChildEvidence?: boolean;
}

interface CompletionToolDetails {
  accepted: boolean;
  bytes: number;
  code?: string;
  status?: CompletionPayload["status"];
}

export function createCompletionTool(
  outputSchema: JsonSchema,
  budget: SkillBudget,
  onTrace?: (type: string, data?: unknown) => void,
  options: CompletionToolOptions = {},
): CompletionToolHandle {
  let completion: CompletionPayload | undefined;
  let protocolIssue: CompletionProtocolIssue | undefined;
  const dataSchema = Type.Unsafe(outputSchema as TSchema);
  const schema = Type.Object({
    status: Type.Union([
      Type.Literal("SUCCESS"),
      Type.Literal("PARTIAL"),
      Type.Literal("NEED_CONTEXT"),
      Type.Literal("BLOCKED"),
    ]),
    summary: Type.String({ minLength: 1, maxLength: 4_000 }),
    data: Type.Optional(dataSchema),
    evidenceRefs: Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: 128 }),
      resource: Type.String({ minLength: 1, maxLength: 1_024 }),
      locator: Type.Optional(Type.String({ maxLength: 1_024 })),
      claim: Type.Optional(Type.String({ maxLength: 2_000 })),
    }, { additionalProperties: false }), { maxItems: 256 }),
    requestedResources: Type.Optional(Type.Array(Type.Object({
      path: Type.String({ minLength: 1, maxLength: 2_048 }),
      operations: Type.Array(Type.Union([
        Type.Literal("read"),
        Type.Literal("list"),
        Type.Literal("search"),
      ]), { minItems: 1, maxItems: 3 }),
      reason: Type.String({ minLength: 1, maxLength: 2_000 }),
    }, { additionalProperties: false }), { maxItems: 32 })),
    warnings: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 64 })),
  }, { additionalProperties: false });

  const tool = defineTool<typeof schema, CompletionToolDetails>({
    name: "scope_complete",
    label: "Complete scoped skill",
    description: "Submit only the final business CompletionPayload. Runtime-owned identity, usage, trace, and error fields are not accepted.",
    promptSnippet: "Submit the final typed result and terminate the scoped session",
    promptGuidelines: [
      "Call scope_complete exactly once as the final action for every scoped skill, including NEED_CONTEXT or BLOCKED outcomes.",
      "NEED_CONTEXT requires a non-empty requestedResources list; omit requestedResources for SUCCESS, PARTIAL, and BLOCKED.",
      "Every evidenceIds string nested in data must name an id present in top-level evidenceRefs.",
      ...(options.runtimeBindsChildEvidence
        ? ["Set evidenceRefs to []; Runtime will replace them with canonical refs for the child results actually produced by this Scope."]
        : []),
      "Never invent runtime metadata such as scopeId, traceId, token usage, timestamps, or skill version.",
    ],
    parameters: schema,
    async execute(toolCallId, params) {
      const candidate = params as CompletionPayload;
      const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (bytes > budget.maxResultBytes) {
        onTrace?.("completion_rejected", { code: "RESULT_TOO_LARGE", bytes, limit: budget.maxResultBytes });
        return {
          content: [{ type: "text", text: `CompletionPayload is ${bytes} bytes; limit is ${budget.maxResultBytes}. Submit a smaller payload.` }],
          details: { accepted: false, code: "RESULT_TOO_LARGE", bytes },
        };
      }

      if (completion !== undefined) {
        protocolIssue = {
          code: "DUPLICATE_COMPLETION",
          message: "scope_complete accepted more than once; only the first valid completion is permitted",
        };
        onTrace?.("completion_rejected", { code: protocolIssue.code, bytes });
        return {
          content: [{ type: "text", text: protocolIssue.message }],
          details: { accepted: false, code: protocolIssue.code, bytes },
          terminate: true,
        };
      }

      const decision = options.beforeAccept?.(toolCallId, candidate) ?? { accept: true };
      if (!decision.accept) {
        const code = decision.code ?? "COMPLETION_REJECTED";
        const message = decision.message ?? "scope_complete is not valid at this point in the tool protocol";
        if (decision.fatal) protocolIssue = { code, message };
        onTrace?.("completion_rejected", { code, bytes, fatal: decision.fatal === true });
        return {
          content: [{ type: "text", text: message }],
          details: { accepted: false, code, bytes },
          ...(decision.fatal ? { terminate: true } : {}),
        };
      }

      completion = candidate;
      onTrace?.("completion_accepted", { status: candidate.status, bytes });
      return {
        content: [{ type: "text", text: `Scoped skill completed with status ${candidate.status}.` }],
        details: { accepted: true, status: candidate.status, bytes },
        terminate: true,
      };
    },
  });

  return {
    tool,
    getCompletion: () => completion,
    getProtocolIssue: () => protocolIssue,
  };
}
