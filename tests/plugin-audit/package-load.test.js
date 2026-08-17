import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCallback);

test("Pi 0.84.2 DefaultResourceLoader loads the shipped TypeScript extension", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "skillscope-package-load-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [resolve("src/pi/index.ts")],
    additionalSkillPaths: [resolve("skills")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await loader.reload();
  const loaded = loader.getExtensions();

  assert.equal(loaded.errors.length, 0);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0].path, resolve("src/pi/index.ts"));
  assert.equal(loader.getSkills().diagnostics.length, 0);
  assert.ok(loader.getSkills().skills.some((skill) => skill.name === "analyze-evidence"));
});

test("the actual npm tarball loads after installing its declared peer dependencies", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "skillscope-packed-load-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const unpacked = join(base, "unpacked");
  await mkdir(unpacked);

  const { stdout } = await execFile("npm", ["pack", "--json", "--pack-destination", base], {
    cwd: process.cwd(),
  });
  const [{ filename }] = JSON.parse(stdout);
  await execFile("tar", ["-xzf", join(base, filename), "-C", unpacked]);

  const packageRoot = join(unpacked, "package");
  // A real consumer gets these through npm's peer-dependency installation.
  // The symlink keeps this probe offline while exercising files from the
  // produced tarball rather than the source worktree.
  await symlink(resolve("node_modules"), join(packageRoot, "node_modules"), "dir");
  const agentDir = join(base, "agent");
  await mkdir(agentDir);
  const loader = new DefaultResourceLoader({
    cwd: packageRoot,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [join(packageRoot, "src/pi/index.ts")],
    additionalSkillPaths: [join(packageRoot, "skills")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await loader.reload();

  assert.equal(loader.getExtensions().errors.length, 0);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.equal(loader.getSkills().diagnostics.length, 0);
  assert.ok(loader.getSkills().skills.some((skill) => skill.name === "analyze-evidence"));
});
