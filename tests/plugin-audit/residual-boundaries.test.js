import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "../pi/register-typescript.js";

const { CoreResourceGatewayFactory } = await import("../../src/pi/core-resource-gateway.ts");
const { createEphemeralChildModelRuntime } = await import("../../src/pi/pi-backend.ts");
const { TraceStore } = await import("../../src/pi/trace-store.ts");

test("list-only snapshots preserve names without materializing file contents", async (t) => {
  const root = await fixture(t, "list-snapshot");
  const resources = join(root.project, "resources");
  await mkdir(resources);
  await writeFile(join(resources, "small.txt"), "ok");
  await writeFile(join(resources, "large.txt"), "12345");
  await writeFile(join(resources, "binary.bin"), Buffer.from([0, 1]));

  const gateway = await new CoreResourceGatewayFactory({ maxFileBytes: 4 }).create({
    ...backendRequest(root.project),
    skill: {
      ...backendRequest(root.project).skill,
      allowedTools: ["scope_list"],
      resourcePolicy: {
        defaultAccessMode: "BOUNDED",
        allowedAccessModes: ["BOUNDED"],
        allowedOperations: ["list"],
      },
    },
    resourceGrants: [{ path: "resources", kind: "directory", operations: ["list"] }],
  });

  // A list-only grant must not turn physical body reads into an unreported
  // side effect, and file types/sizes must not change directory visibility.
  assert.deepEqual(gateway.snapshot().actualReadSet, []);
  assert.deepEqual(gateway.snapshot().physicalMaterializedSet, []);
  const list = gateway.tools.find((tool) => tool.name === "scope_list");
  const result = await list.execute("list-audit", { path: "resources", recursive: false, maxEntries: 20 });
  const visibleNames = result.details.entries.map((entry) => entry.path);

  assert.deepEqual(visibleNames, [
    "resources/binary.bin",
    "resources/large.txt",
    "resources/small.txt",
  ]);
});

test("metadata-only Trace hashes path-like sensitive strings", async (t) => {
  const root = await fixture(t, "trace-paths");
  const marker = "AUDIT-PATH-SENTINEL-SHOULD-BE-HASHED";
  const store = new TraceStore(root.traces);
  const trace = await store.begin("scope-audit", root.project, {
    resourceGrants: [{ path: marker, kind: "file", operations: ["read"] }],
    promptRefs: [{ kind: "file", name: marker, path: marker }],
  });
  await trace.finish({
    status: "SUCCESS",
    resourceAudit: {
      attemptedSet: [marker],
      modelVisibleSources: [`tool:read:${marker}`],
    },
  });

  const directory = join(root.traces, "scope-audit");
  const persisted = [
    await readFile(join(directory, "manifest.json"), "utf8"),
    await readFile(join(directory, "result.json"), "utf8"),
  ].join("\n");

  assert.equal(persisted.includes(marker), false);
  assert.match(persisted, /"(?:path|name)Hash": "sha256:/);
});

test("child auth bridge preserves case-insensitive parent header deletion", async () => {
  const providerId = "skillscope-header-deletion-audit";
  const selectedModel = model(providerId, "audit-model", "https://example.invalid/v1");
  const runtime = await createEphemeralChildModelRuntime({
    model: selectedModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "dummy-audit-key",
        headers: { authorization: null },
      }),
      getRegisteredProviderConfig: () => ({
        api: "openai-completions",
        baseUrl: "https://example.invalid/v1",
        headers: { Authorization: "dummy-stale-header" },
        models: [modelDefinition("audit-model", "https://example.invalid/v1")],
      }),
      getRegisteredNativeProvider: () => undefined,
      getProvider: () => undefined,
      isUsingOAuth: () => false,
    },
  });

  const auth = await runtime.getAuth(runtime.getModel(providerId, "audit-model"));

  assert.equal(auth.auth.headers?.Authorization, undefined);
  assert.equal(auth.auth.headers?.authorization, undefined);
});

function backendRequest(cwd) {
  const budget = {
    maxTurns: 2,
    maxToolCalls: 2,
    timeoutMs: 1_000,
    maxPromptBytes: 10_000,
    maxResultBytes: 10_000,
  };
  return {
    scopeId: "scope",
    invocationId: "invocation",
    cwd,
    skill: {
      name: "audit-skill",
      version: "1.0.0",
      description: "audit fixture",
      promptFile: "SKILL.md",
      inputSchema: {},
      outputSchema: {},
      allowedTools: ["scope_read", "scope_list", "scope_search"],
      resourcePolicy: {
        defaultAccessMode: "BOUNDED",
        allowedAccessModes: ["BOUNDED"],
        allowedOperations: ["read", "list", "search"],
      },
      budget,
      directory: "",
      instructions: "Return a result.",
    },
    input: {},
    promptRefs: [],
    resourceGrants: [],
    accessMode: "BOUNDED",
    budget,
  };
}

function model(provider, id, baseUrl) {
  return { provider, ...modelDefinition(id, baseUrl) };
}

function modelDefinition(id, baseUrl) {
  return {
    id,
    name: id,
    api: "openai-completions",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4_096,
    maxTokens: 1_024,
  };
}

async function fixture(t, name) {
  const base = await mkdtemp(join(tmpdir(), `skillscope-${name}-`));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  const traces = join(base, "traces");
  await mkdir(project);
  return { project, traces };
}
