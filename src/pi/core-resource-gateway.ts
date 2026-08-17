import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  PromptRef,
  ResourceAuditSnapshot,
  ResourceGrant,
  ResourceOperation,
  ScopeBackendRequest,
} from "./contracts.js";
import type { MaterializedPromptRef } from "./prompt.js";
import type { ResourceGateway, ResourceGatewayFactory } from "./resource-gateway.js";

interface BrokerLike {
  read(path: string, options?: { startLine?: number; endLine?: number; maxBytes?: number }): unknown;
  list(path?: string, options?: { recursive?: boolean; maxEntries?: number }): unknown;
  search(query: string, options?: { path?: string; caseSensitive?: boolean; maxResults?: number }): unknown;
  snapshot(): ResourceAuditSnapshot;
  getPromptMaterials(): Array<{
    name: string;
    content: string;
    sourcePath?: string;
    startLine?: number;
    endLine?: number;
  }>;
}

interface ResourceBrokerConstructor {
  new(options: {
    files: Record<string, string>;
    mode: ScopeBackendRequest["accessMode"];
    declaredGrants: ResourceGrant[];
    grants: ResourceGrant[];
    canaries: string[];
    promptRefs: unknown[];
  }): BrokerLike;
}

interface CoreModule {
  ResourceBroker: ResourceBrokerConstructor;
}

export interface CoreResourceGatewayOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  projectExcludeDirectories?: string[];
  loadCore?: () => Promise<CoreModule>;
}

const DEFAULTS = {
  maxFiles: 5_000,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  projectExcludeDirectories: [".git", ".pi", "node_modules"],
};

export class CoreResourceGatewayFactory implements ResourceGatewayFactory {
  private readonly options: CoreResourceGatewayOptions;

  constructor(options: CoreResourceGatewayOptions = {}) {
    this.options = options;
  }

  async create(request: ScopeBackendRequest): Promise<ResourceGateway> {
    const config = { ...DEFAULTS, ...this.options };
    const { files, physicalMaterializedSet } = await loadAuthorizedFiles(request, config);
    const core = await (this.options.loadCore ?? loadDefaultCore)();
    const declaredGrants = request.accessMode === "PROJECT"
      ? [{ path: ".", kind: "directory" as const, operations: [...request.skill.resourcePolicy.allowedOperations] }]
      : request.resourceGrants;
    const broker = new core.ResourceBroker({
      files,
      mode: request.accessMode,
      declaredGrants,
      grants: request.resourceGrants,
      canaries: [],
      promptRefs: request.promptRefs.map(promptRefIdentity),
    });
    return new CoreResourceGateway(request, broker, config, physicalMaterializedSet);
  }
}

class CoreResourceGateway implements ResourceGateway {
  readonly tools: ToolDefinition[];
  private readonly request: ScopeBackendRequest;
  private readonly broker: BrokerLike;
  private readonly config: typeof DEFAULTS;
  private readonly physicalMaterializedSet: string[];

  constructor(
    request: ScopeBackendRequest,
    broker: BrokerLike,
    config: typeof DEFAULTS,
    physicalMaterializedSet: string[],
  ) {
    this.request = request;
    this.broker = broker;
    this.config = config;
    this.physicalMaterializedSet = physicalMaterializedSet;
    this.tools = createBrokerTools(broker, request.skill.resourcePolicy.allowedOperations);
  }

  async materializePromptRefs(refs: PromptRef[]): Promise<MaterializedPromptRef[]> {
    // ResourceBroker resolves and records prompt visibility at construction.
    // Checking the count guards adapter/config drift without re-reading files.
    const materials = this.broker.getPromptMaterials();
    if (materials.length !== refs.length) throw new Error("ResourceBroker returned an unexpected prompt material count");
    return materials.map((material) => ({
      name: material.name,
      source: material.sourcePath
        ? `file://${material.sourcePath}${material.startLine === undefined ? "" : `#L${material.startLine}-L${material.endLine}`}`
        : `inline://${material.name}`,
      content: material.content,
    }));
  }

  snapshot(): ResourceAuditSnapshot {
    return {
      ...this.broker.snapshot(),
      physicalMaterializedSet: [...this.physicalMaterializedSet],
    };
  }
}

function createBrokerTools(
  broker: BrokerLike,
  allowedOperations: readonly ResourceOperation[],
): ToolDefinition[] {
  const readSchema = Type.Object({
    path: Type.String({ minLength: 1, maxLength: 2_048 }),
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536, default: 65_536 })),
  }, { additionalProperties: false });
  const listSchema = Type.Object({
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048, default: "." })),
    recursive: Type.Optional(Type.Boolean({ default: false })),
    maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000, default: 500 })),
  }, { additionalProperties: false });
  const searchSchema = Type.Object({
    query: Type.String({ minLength: 1, maxLength: 2_048 }),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048, default: "." })),
    caseSensitive: Type.Optional(Type.Boolean({ default: true })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 100 })),
  }, { additionalProperties: false });

  const tools = [
    defineTool({
      name: "scope_read",
      label: "Read granted resource",
      description: "Read a file only when the active resource grant permits read access.",
      parameters: readSchema,
      async execute(_id, params) {
        const result = broker.read(params.path, { startLine: params.startLine, endLine: params.endLine, maxBytes: params.maxBytes });
        return brokerToolResult(result);
      },
    }),
    defineTool({
      name: "scope_list",
      label: "List granted resources",
      description: "List files only within a directory grant that permits list access.",
      parameters: listSchema,
      async execute(_id, params) {
        const result = broker.list(params.path ?? ".", { recursive: params.recursive, maxEntries: params.maxEntries });
        return brokerToolResult(result);
      },
    }),
    defineTool({
      name: "scope_search",
      label: "Search granted resources",
      description: "Search text only within resource grants that permit search access.",
      parameters: searchSchema,
      async execute(_id, params) {
        const result = broker.search(params.query, { path: params.path ?? ".", caseSensitive: params.caseSensitive, maxResults: params.maxResults });
        return brokerToolResult(result);
      },
    }),
  ];
  return tools.filter((tool) => {
    const operation = tool.name === "scope_read"
      ? "read"
      : tool.name === "scope_list"
        ? "list"
        : tool.name === "scope_search"
          ? "search"
          : undefined;
    return operation !== undefined && allowedOperations.includes(operation);
  });
}

function brokerToolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

async function loadAuthorizedFiles(
  request: ScopeBackendRequest,
  config: typeof DEFAULTS,
): Promise<{ files: Record<string, string>; physicalMaterializedSet: string[] }> {
  const files: Record<string, string> = {};
  const seen = new Set<string>();
  const contentLoaded = new Set<string>();
  let totalBytes = 0;
  throwIfAborted(request.signal);
  const canonicalCwd = await realpath(request.cwd);
  throwIfAborted(request.signal);

  const roots: Array<{ path: string; explicit: boolean; needsContent: boolean }> = [];
  if (request.accessMode === "PROJECT") roots.push({
    path: ".",
    explicit: false,
    needsContent: request.skill.resourcePolicy.allowedOperations.some((operation) => operation === "read" || operation === "search"),
  });
  if (request.accessMode === "BOUNDED") roots.push(...request.resourceGrants.map((grant) => ({
    path: grant.path,
    explicit: true,
    needsContent: grant.operations.some((operation) => operation === "read" || operation === "search"),
  })));
  roots.push(...request.promptRefs.filter((ref): ref is Extract<PromptRef, { kind: "file" }> => ref.kind === "file")
    .map((ref) => ({ path: ref.path, explicit: true, needsContent: true })));

  for (const root of roots) {
    throwIfAborted(request.signal);
    const absolute = await resolveSafeExisting(canonicalCwd, root.path, request.signal);
    const info = await lstat(absolute);
    throwIfAborted(request.signal);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported by the in-process broker adapter: ${root.path}`);
    if (info.isFile()) await addFile(absolute, root.explicit, root.needsContent);
    else if (info.isDirectory()) await walk(absolute, request.accessMode === "PROJECT", root.needsContent);
  }
  return { files, physicalMaterializedSet: [...contentLoaded].sort() };

  async function walk(directory: string, applyProjectExcludes: boolean, needsContent: boolean): Promise<void> {
    throwIfAborted(request.signal);
    const entries = await readdir(directory, { withFileTypes: true });
    throwIfAborted(request.signal);
    for (const entry of entries) {
      throwIfAborted(request.signal);
      if (entry.isSymbolicLink()) continue;
      if (applyProjectExcludes && entry.isDirectory() && config.projectExcludeDirectories.includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path, applyProjectExcludes, needsContent);
      else if (entry.isFile()) await addFile(path, false, needsContent);
    }
  }

  async function addFile(absolute: string, explicit: boolean, needsContent: boolean): Promise<void> {
    throwIfAborted(request.signal);
    const canonical = await realpath(absolute);
    throwIfAborted(request.signal);
    assertWithin(canonicalCwd, canonical);
    const key = normalizeRelativePath(relative(canonicalCwd, canonical));
    if (seen.has(key) && (!needsContent || contentLoaded.has(key))) return;
    if (!seen.has(key)) {
      if (seen.size >= config.maxFiles) throw new Error(`Resource snapshot exceeds ${config.maxFiles} files`);
      seen.add(key);
      // Metadata-only list grants need filenames, not file contents. Broker
      // uses the empty value only to materialize the virtual directory tree.
      files[key] = "";
    }
    if (!needsContent) return;
    const fileStats = await stat(canonical);
    throwIfAborted(request.signal);
    if (fileStats.size > config.maxFileBytes) {
      throw new Error(`${explicit ? "Explicit resource" : "Resource"} exceeds per-file snapshot limit: ${key}`);
    }
    const content = await readText(canonical, request.signal);
    if (content.includes("\0")) {
      throw new Error(`${explicit ? "Explicit resource" : "Resource"} is binary and cannot be exposed as text: ${key}`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (totalBytes + bytes > config.maxTotalBytes) throw new Error(`Resource snapshot exceeds ${config.maxTotalBytes} total bytes`);
    totalBytes += bytes;
    files[key] = content;
    contentLoaded.add(key);
  }
}

async function resolveSafeExisting(cwd: string, candidate: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (isAbsolute(candidate) || candidate.includes("\0")) throw new Error(`Resource path must be a project-relative path: ${candidate}`);
  const lexical = resolve(cwd, candidate);
  assertWithin(cwd, lexical);
  const lexicalInfo = await lstat(lexical);
  const canonical = await realpath(lexical);
  throwIfAborted(signal);
  assertWithin(cwd, canonical);
  if (lexicalInfo.isSymbolicLink()) throw new Error(`Explicit resource roots cannot be symbolic links: ${candidate}`);
  return canonical;
}

function assertWithin(cwd: string, candidate: string): void {
  const child = relative(resolve(cwd), resolve(candidate));
  if (!(child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))) return;
  throw new Error(`Resource path escapes project root: ${candidate}`);
}

async function readText(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return readFile(path, { encoding: "utf8", signal });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Scoped resource snapshot aborted");
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function promptRefIdentity(ref: PromptRef): unknown {
  return ref.kind === "inline"
    ? { name: ref.name, content: ref.content }
    : { name: ref.name, path: normalizeRelativePath(ref.path), startLine: ref.startLine, endLine: ref.endLine };
}

async function loadDefaultCore(): Promise<CoreModule> {
  // Keep the core boundary explicit while allowing src/core to remain plain JS.
  const specifier = "../core/index.js";
  const module = await import(specifier) as unknown as Partial<CoreModule>;
  if (typeof module.ResourceBroker !== "function") throw new Error("src/core/index.js does not export ResourceBroker");
  return module as CoreModule;
}
