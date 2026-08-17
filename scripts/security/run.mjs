#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const buildRoot = await mkdtemp(join(tmpdir(), "skillscope-security-build-"));

try {
  // Compiled modules live under a system temp directory. Give Node's ESM
  // resolver a local, non-copying route to the repository dependencies.
  await symlink(join(repositoryRoot, "node_modules"), join(buildRoot, "node_modules"), "dir");
  execFileSync(join(repositoryRoot, "node_modules/.bin/tsc"), [
    "--ignoreConfig",
    join(repositoryRoot, "src/pi/trace-store.ts"),
    join(repositoryRoot, "src/pi/core-resource-gateway.ts"),
    "--outDir", buildRoot,
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2023",
    "--types", "node",
    "--skipLibCheck", "true",
    "--declaration", "false",
    "--sourceMap", "false",
  ], { cwd: repositoryRoot, stdio: "inherit" });

  const testRoot = join(repositoryRoot, "tests/security");
  const tests = (await readdir(testRoot))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(testRoot, name));

  const testRun = spawnSync(process.execPath, ["--test", ...tests], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SKILLSCOPE_TRACE_MODULE: join(buildRoot, "trace-store.js"),
      SKILLSCOPE_GATEWAY_MODULE: join(buildRoot, "core-resource-gateway.js"),
    },
    stdio: "inherit",
  });

  if (testRun.error) throw testRun.error;
  process.exitCode = testRun.status ?? 1;
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}
