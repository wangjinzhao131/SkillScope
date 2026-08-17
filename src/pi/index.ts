import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ScopeBackend, SkillInvocation, SkillResult } from "./contracts.js";
import { CoreResourceGatewayFactory } from "./core-resource-gateway.js";
import { PiInProcessBackend } from "./pi-backend.js";
import type { ResourceGatewayFactory } from "./resource-gateway.js";
import { SkillScopeRuntime } from "./runtime.js";
import { SkillRegistry } from "./skill-registry.js";
import { TraceStore } from "./trace-store.js";

export interface SkillScopeExtensionOptions {
  skillsRoot?: string;
  traceRoot?: string;
  gatewayFactory?: ResourceGatewayFactory;
  backend?: ScopeBackend;
}

export function createSkillScopeExtension(options: SkillScopeExtensionOptions = {}) {
  return function install(pi: ExtensionAPI): void {
    const skillsRoot = options.skillsRoot ?? fileURLToPath(new URL("../../skills/", import.meta.url));
    const traceRoot = options.traceRoot ?? process.env.SKILLSCOPE_TRACE_ROOT ?? join(homedir(), ".pi", "agent", "skillscope", "traces");
    const gatewayFactory = options.gatewayFactory ?? new CoreResourceGatewayFactory();
    const backend = options.backend ?? new PiInProcessBackend({ gatewayFactory });
    const runtime = new SkillScopeRuntime({
      registry: new SkillRegistry(skillsRoot),
      backend,
      traceStore: new TraceStore(traceRoot),
    });

    pi.registerTool(createScopedSkillRunTool(runtime));
    pi.on("session_shutdown", async () => runtime.dispose());
  };
}

export default createSkillScopeExtension();

function createScopedSkillRunTool(runtime: SkillScopeRuntime): ToolDefinition {
  const operationSchema = Type.Union([
    Type.Literal("read"),
    Type.Literal("list"),
    Type.Literal("search"),
  ]);
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
  const parameters = Type.Object({
    skill: Type.String({ minLength: 1, maxLength: 64, description: "Installed scoped skill name" }),
    input: Type.Unknown({ description: "Input validated against the selected skill's inputSchema" }),
    promptRefs: Type.Optional(Type.Array(promptRefSchema, {
      maxItems: 64,
      description: "Immutable content injected at child-session startup; separate from exploration grants",
    })),
    resourceGrants: Type.Optional(Type.Array(Type.Object({
      path: Type.String({ minLength: 1, maxLength: 2_048 }),
      kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
      operations: Type.Array(operationSchema, { minItems: 1, maxItems: 3 }),
    }, { additionalProperties: false }), { maxItems: 128 })),
    accessMode: Type.Optional(Type.Union([
      Type.Literal("SEALED"),
      Type.Literal("BOUNDED"),
      Type.Literal("PROJECT"),
    ])),
    budgetOverride: Type.Optional(Type.Object({
      maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
      maxToolCalls: Type.Optional(Type.Integer({ minimum: 1 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      maxPromptBytes: Type.Optional(Type.Integer({ minimum: 1 })),
      maxResultBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false })),
  }, { additionalProperties: false });

  return defineTool({
    name: "scoped_skill_run",
    label: "Run scoped skill",
    description: "Run one installed skill in a fresh Pi AgentSession with separate prompt refs, resource grants, budgets, typed completion, and an external trace.",
    promptSnippet: "Delegate a bounded read-only task to an isolated scoped skill",
    promptGuidelines: [
      "Use scoped_skill_run when a subtask has a clear input and compact result contract.",
      "Keep promptRefs minimal; grant only the files or directories the scoped skill may explore.",
      "Use accessMode PROJECT only for a trusted project when bounded discovery is impractical.",
    ],
    executionMode: "parallel",
    parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Preparing scoped skill ${params.skill}…` }], details: undefined });
      const result = await runtime.invoke(params as SkillInvocation, {
        cwd: ctx.cwd,
        parentSessionId: ctx.sessionManager.getSessionId(),
        signal: signal ?? ctx.signal,
        hostContext: { model: ctx.model, modelRegistry: ctx.modelRegistry, thinkingLevel: ctx.thinkingLevel },
        onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined }),
      });
      return toPiResult(result);
    },
  });
}

function toPiResult(result: SkillResult) {
  const compact = {
    status: result.status,
    summary: result.summary,
    data: result.data,
    evidenceRefs: result.evidenceRefs,
    requestedResources: result.requestedResources,
    warnings: result.warnings,
    error: result.error,
    scopeId: result.scopeId,
    traceId: result.traceId,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compact, null, 2) }],
    details: result,
  };
}
