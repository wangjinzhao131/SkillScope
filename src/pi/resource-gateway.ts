import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PromptRef, ResourceAuditSnapshot, ScopeBackendRequest } from "./contracts.js";
import type { MaterializedPromptRef } from "./prompt.js";

/** Pi-facing adapter boundary around src/core/ResourceBroker. */
export interface ResourceGateway {
  readonly tools: ToolDefinition[];
  materializePromptRefs(refs: PromptRef[]): Promise<MaterializedPromptRef[]>;
  snapshot(): ResourceAuditSnapshot;
}

export interface ResourceGatewayFactory {
  create(request: ScopeBackendRequest): Promise<ResourceGateway>;
}
