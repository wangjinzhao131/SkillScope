import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { ResourceBroker } from "../../src/core/index.js";

const gatewayModulePath = process.env.SKILLSCOPE_GATEWAY_MODULE;
if (!gatewayModulePath) {
  throw new Error("Run security tests through scripts/security/run.mjs");
}
const { CoreResourceGatewayFactory } = await import(pathToFileURL(gatewayModulePath));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "skillscope-gateway-hostile-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project);
  await mkdir(outside);
  return { root, project, outside };
}

function request(cwd, overrides = {}) {
  return {
    scopeId: "scope-security",
    invocationId: "invocation-security",
    cwd,
    skill: {
      resourcePolicy: { allowedOperations: ["read", "list", "search"] },
      allowedTools: ["scope_read", "scope_list", "scope_search"],
    },
    input: {},
    promptRefs: [],
    resourceGrants: [],
    accessMode: "BOUNDED",
    budget: {},
    ...overrides,
  };
}

function capturingFactory(factoryOptions = {}) {
  const state = { constructionCount: 0, options: undefined };
  class CapturingBroker extends ResourceBroker {
    constructor(options) {
      super(options);
      state.constructionCount += 1;
      state.options = options;
    }
  }
  const factory = new CoreResourceGatewayFactory({
    loadCore: async () => ({ ResourceBroker: CapturingBroker }),
    ...factoryOptions,
  });
  return { factory, state };
}

test("real-fs adapter snapshots an explicitly granted in-project file", async (t) => {
  const { project } = await workspace(t);
  await mkdir(join(project, "safe"));
  await writeFile(join(project, "safe", "allowed.txt"), "allowed evidence", "utf8");
  const { factory, state } = capturingFactory();

  const gateway = await factory.create(request(project, {
    resourceGrants: [{ path: "safe/allowed.txt", kind: "file", operations: ["read"] }],
  }));

  assert.equal(state.constructionCount, 1);
  assert.deepEqual(state.options.files, { "safe/allowed.txt": "allowed evidence" });
  assert.deepEqual(gateway.snapshot().modelVisibleSet, []);
});

test("real-fs adapter rejects an explicitly granted file symlink escaping cwd", async (t) => {
  const { project, outside } = await workspace(t);
  const outsideSecret = join(outside, "secret.txt");
  await writeFile(outsideSecret, "outside secret", "utf8");
  await symlink(outsideSecret, join(project, "escape.txt"), "file");
  const { factory, state } = capturingFactory();

  await assert.rejects(
    factory.create(request(project, {
      resourceGrants: [{ path: "escape.txt", kind: "file", operations: ["read"] }],
    })),
    /escapes project root/,
  );
  assert.equal(state.constructionCount, 0);
});

test("real-fs adapter rejects an explicitly granted directory symlink escaping cwd", async (t) => {
  const { project, outside } = await workspace(t);
  await writeFile(join(outside, "secret.txt"), "outside directory secret", "utf8");
  await symlink(outside, join(project, "escape-dir"), "dir");
  const { factory, state } = capturingFactory();

  await assert.rejects(
    factory.create(request(project, {
      resourceGrants: [{ path: "escape-dir", kind: "directory", operations: ["read", "list"] }],
    })),
    /escapes project root/,
  );
  assert.equal(state.constructionCount, 0);
});

test("PROJECT walk skips file and directory symlinks instead of following them", async (t) => {
  const { project, outside } = await workspace(t);
  await mkdir(join(project, "safe"));
  await writeFile(join(project, "safe", "visible.txt"), "visible", "utf8");
  await writeFile(join(outside, "secret.txt"), "outside secret", "utf8");
  await symlink(join(outside, "secret.txt"), join(project, "secret-link.txt"), "file");
  await symlink(outside, join(project, "outside-dir-link"), "dir");
  const { factory, state } = capturingFactory();

  await factory.create(request(project, { accessMode: "PROJECT" }));

  assert.deepEqual(state.options.files, { "safe/visible.txt": "visible" });
  assert.equal(JSON.stringify(state.options).includes("outside secret"), false);
});

test("real-fs adapter rejects absolute and lexical traversal roots before Broker construction", async (t) => {
  const { project, outside } = await workspace(t);
  const outsideSecret = join(outside, "secret.txt");
  await writeFile(outsideSecret, "outside secret", "utf8");

  for (const hostilePath of [outsideSecret, "../outside/secret.txt"]) {
    const { factory, state } = capturingFactory();
    await assert.rejects(
      factory.create(request(project, {
        resourceGrants: [{ path: hostilePath, kind: "file", operations: ["read"] }],
      })),
      /project-relative|escapes project root/,
    );
    assert.equal(state.constructionCount, 0);
  }
});

test("excluded PROJECT directories and their contents do not enter the snapshot", async (t) => {
  const { project } = await workspace(t);
  await mkdir(join(project, ".pi"));
  await mkdir(join(project, ".git"));
  await mkdir(join(project, "node_modules"));
  await writeFile(join(project, ".pi", "trace.json"), "trace canary", "utf8");
  await writeFile(join(project, ".git", "config"), "git canary", "utf8");
  await writeFile(join(project, "node_modules", "secret.js"), "dependency canary", "utf8");
  await writeFile(join(project, "visible.txt"), "visible", "utf8");
  const { factory, state } = capturingFactory();

  await factory.create(request(project, { accessMode: "PROJECT" }));

  assert.deepEqual(state.options.files, { "visible.txt": "visible" });
});
