import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "./register-typescript.js";

const { CoreResourceGatewayFactory } = await import("../../src/pi/core-resource-gateway.ts");

test("BOUNDED gateway exposes granted roots and records denied attempts", async (t) => {
  const root = await projectFixture(t);
  const gateway = await new CoreResourceGatewayFactory().create(request(root.project, {
    accessMode: "BOUNDED",
    resourceGrants: [{ path: "allowed", kind: "directory", operations: ["read", "list", "search"] }],
  }));
  const read = gateway.tools.find((tool) => tool.name === "scope_read");
  const ok = await read.execute("1", { path: "allowed/fact.txt" });
  assert.match(ok.content[0].text, /alpha/);
  await assert.rejects(() => read.execute("2", { path: "secret.txt" }), /outside the effective grant|does not exist/);
  const audit = gateway.snapshot();
  assert.deepEqual(audit.actualReadSet, ["allowed/fact.txt"]);
  assert.equal(audit.denials.length, 1);
  assert.equal(audit.denials[0].code, "UNAUTHORIZED");
});

test("SEALED gateway injects explicit file prompt ref but denies exploration", async (t) => {
  const root = await projectFixture(t);
  const gateway = await new CoreResourceGatewayFactory().create(request(root.project, {
    accessMode: "SEALED",
    promptRefs: [{ kind: "file", name: "fact", path: "allowed/fact.txt", startLine: 1, endLine: 1 }],
  }));
  const refs = await gateway.materializePromptRefs([{ kind: "file", name: "fact", path: "allowed/fact.txt", startLine: 1, endLine: 1 }]);
  assert.equal(refs[0].content, "alpha");
  const read = gateway.tools.find((tool) => tool.name === "scope_read");
  await assert.rejects(() => read.execute("1", { path: "allowed/fact.txt" }), /SEALED/);
  const audit = gateway.snapshot();
  assert.deepEqual(audit.modelVisibleSet, ["allowed/fact.txt"]);
  assert.equal(audit.denials[0].code, "SEALED");
});

test("gateway refuses a grant whose real path escapes through a symlink", async (t) => {
  const root = await projectFixture(t);
  const outside = join(root.base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "leak.txt"), "must-not-load");
  await symlink(outside, join(root.project, "escape"));
  await assert.rejects(
    () => new CoreResourceGatewayFactory().create(request(root.project, {
      accessMode: "BOUNDED",
      resourceGrants: [{ path: "escape", kind: "directory", operations: ["read"] }],
    })),
    /escapes project root/,
  );
});

test("PROJECT gateway still enforces the skill operation policy", async (t) => {
  const root = await projectFixture(t);
  const gateway = await new CoreResourceGatewayFactory().create(request(root.project, {
    accessMode: "PROJECT",
    skill: {
      ...request(root.project).skill,
      allowedTools: ["scope_read", "scope_list", "scope_search"],
      resourcePolicy: {
        defaultAccessMode: "PROJECT",
        allowedAccessModes: ["PROJECT"],
        allowedOperations: ["read"],
      },
    },
  }));

  assert.deepEqual(gateway.tools.map((tool) => tool.name), ["scope_read"]);
  const read = gateway.tools[0];
  const result = await read.execute("1", { path: "allowed/fact.txt" });
  assert.match(result.content[0].text, /alpha/);
});

test("list-only directory grants materialize names without pre-reading content", async (t) => {
  const root = await projectFixture(t);
  await writeFile(join(root.project, "allowed", "binary.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
  const factory = new CoreResourceGatewayFactory({ maxFileBytes: 4 });
  const gateway = await factory.create(request(root.project, {
    accessMode: "BOUNDED",
    resourceGrants: [{ path: "allowed", kind: "directory", operations: ["list"] }],
    skill: {
      ...request(root.project).skill,
      allowedTools: ["scope_list"],
      resourcePolicy: {
        defaultAccessMode: "BOUNDED",
        allowedAccessModes: ["BOUNDED"],
        allowedOperations: ["list"],
      },
    },
  }));
  const listed = await gateway.tools[0].execute("1", { path: "allowed" });
  assert.deepEqual(listed.details.entries.map((entry) => entry.path), [
    "allowed/binary.bin",
    "allowed/fact.txt",
  ]);
  assert.deepEqual(gateway.snapshot().physicalMaterializedSet, []);

  await assert.rejects(() => factory.create(request(root.project, {
    accessMode: "BOUNDED",
    resourceGrants: [{ path: "allowed", kind: "directory", operations: ["read"] }],
  })), /exceeds per-file snapshot limit|binary/);
});

async function projectFixture(t) {
  const base = await mkdtemp(join(tmpdir(), "skillscope-pi-gateway-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(join(project, "allowed"), { recursive: true });
  await writeFile(join(project, "allowed", "fact.txt"), "alpha\nbeta\n");
  await writeFile(join(project, "secret.txt"), "hidden\n");
  return { base, project };
}

function request(project, overrides = {}) {
  return {
    scopeId: "scope",
    invocationId: "inv",
    cwd: project,
    skill: {
      name: "skill",
      version: "1",
      description: "",
      promptFile: "SKILL.md",
      inputSchema: {},
      outputSchema: {},
      allowedTools: ["scope_read", "scope_list", "scope_search"],
      resourcePolicy: { defaultAccessMode: "BOUNDED", allowedAccessModes: ["SEALED", "BOUNDED", "PROJECT"], allowedOperations: ["read", "list", "search"] },
      budget: { maxTurns: 3, maxToolCalls: 3, timeoutMs: 1000, maxPromptBytes: 10000, maxResultBytes: 10000 },
      directory: "",
      instructions: "",
    },
    input: {},
    promptRefs: [],
    resourceGrants: [],
    accessMode: "BOUNDED",
    budget: { maxTurns: 3, maxToolCalls: 3, timeoutMs: 1000, maxPromptBytes: 10000, maxResultBytes: 10000 },
    ...overrides,
  };
}
