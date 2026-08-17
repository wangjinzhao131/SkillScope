import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const traceModulePath = process.env.SKILLSCOPE_TRACE_MODULE;
if (!traceModulePath) {
  throw new Error("Run security tests through scripts/security/run.mjs");
}
const { TraceStore, assertOutsideProject } = await import(pathToFileURL(traceModulePath));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "skillscope-trace-hostile-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  await mkdir(project);
  return { root, project };
}

test("assertOutsideProject rejects the project and descendants but not prefix collisions", () => {
  const root = resolve("/tmp/skillscope-security-lexical");
  assert.throws(() => assertOutsideProject(join(root, "project"), join(root, "project")), /outside/);
  assert.throws(() => assertOutsideProject(join(root, "project", "traces"), join(root, "project")), /outside/);
  assert.doesNotThrow(() => assertOutsideProject(join(root, "project-traces"), join(root, "project")));
});

test("TraceStore rejects a relative trace root", () => {
  assert.throws(() => new TraceStore("relative/traces"), /absolute path/);
});

test("TraceStore accepts a sibling prefix-collision directory and keeps restrictive modes", async (t) => {
  const { root, project } = await workspace(t);
  const traceRoot = join(root, "project-traces");
  const secretMarker = "SECRET-MANIFEST-MARKER-2a8aaafe";
  const trace = await new TraceStore(traceRoot).begin("scope-safe_01", project, { marker: secretMarker });
  trace.event("checked", { ok: true });
  await trace.finish({ status: "SUCCESS" });

  const manifestText = await readFile(join(trace.directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.traceFormat, "metadata-only-v1");
  assert.match(manifest.manifestHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifestText.includes(secretMarker), false);
  assert.equal((await stat(trace.directory)).mode & 0o077, 0);
  assert.equal((await stat(join(trace.directory, "result.json"))).mode & 0o077, 0);
});

test("TraceStore does not confuse an in-project '..name' segment with the parent '..' segment", async (t) => {
  const { project } = await workspace(t);
  const disguisedChild = join(project, "..traces");
  await assert.rejects(
    new TraceStore(disguisedChild).begin("scope-dot-prefix", project, {}),
    /outside the scoped project/,
  );
  await assert.rejects(lstat(disguisedChild));
});

test("TraceStore rejects a trace root whose external-looking path is a symlink into the project", async (t) => {
  const { root, project } = await workspace(t);
  const projectTraceTarget = join(project, ".hidden-traces");
  const alias = join(root, "external-looking-traces");
  await mkdir(projectTraceTarget);
  await symlink(projectTraceTarget, alias, "dir");

  await assert.rejects(
    new TraceStore(alias).begin("scope-symlink-root", project, {}),
    /outside the scoped project/,
  );
  await assert.rejects(lstat(join(projectTraceTarget, "scope-symlink-root", "manifest.json")));
});

test("TraceStore preflights a symlinked ancestor before creating a missing trace root", async (t) => {
  const { root, project } = await workspace(t);
  const ancestorAlias = join(root, "external-ancestor");
  const wouldLandInProject = join(project, "must-not-be-created");
  await symlink(project, ancestorAlias, "dir");

  await assert.rejects(
    new TraceStore(join(ancestorAlias, "must-not-be-created")).begin("scope-preflight", project, {}),
    /outside the scoped project/,
  );
  await assert.rejects(lstat(wouldLandInProject));
});

test("TraceStore rejects a pre-existing scope directory symlink that escapes traceRoot", async (t) => {
  const { root, project } = await workspace(t);
  const traceRoot = join(root, "traces");
  const projectTarget = join(project, ".injected-trace");
  await mkdir(traceRoot);
  await mkdir(projectTarget);
  await symlink(projectTarget, join(traceRoot, "scope-link"), "dir");

  await assert.rejects(
    new TraceStore(traceRoot).begin("scope-link", project, {}),
    /escapes traceRoot/,
  );
  await assert.rejects(lstat(join(projectTarget, "manifest.json")));
});

test("TraceStore rejects scope ids that could alter the destination path", async (t) => {
  const { root, project } = await workspace(t);
  const store = new TraceStore(join(root, "traces"));
  const hostileIds = ["", ".", "..", "../escape", "safe/escape", "/absolute", "safe\\escape", ".hidden", "a".repeat(129)];
  for (const scopeId of hostileIds) {
    await assert.rejects(store.begin(scopeId, project, {}), /scopeId/);
  }
});
