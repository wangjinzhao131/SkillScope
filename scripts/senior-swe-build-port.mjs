#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assertPinnedSeniorDataset } from "../experiments/senior-swe-composition/src/selector.mjs";

const RECIPES = Object.freeze({
  "better-auth-fix-api-key-run": {
    originalSha256: "7778c95d72a4797520e8b4b0317e5828f1beb28c9aea15b46e54da69c175b2ff",
    search: "RUN npm install -g pnpm@${PNPM_VERSION}",
    replacement: "RUN curl -fsSL \"https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz\" -o /tmp/pnpm.tgz && npm install -g /tmp/pnpm.tgz && rm /tmp/pnpm.tgz",
    reason: "npm registry client stalled on the pinned pnpm tarball; fetch the identical versioned tarball directly",
  },
  "posthog-fix-llm-gateway-add": {
    originalSha256: "471d12cc71370969f8f8b7229e6a6d07b4c78d65009034084bab54d81107e519",
    search: "RUN git fetch --unshallow 2>/dev/null || true",
    replacement: "RUN git fetch --depth=1 origin 423e9cf5e34736e945e06b1dfd1f87d156126089",
    reason: "unshallow download failed silently; fetch only the already-pinned base commit needed by the next reset",
  },
  "electric-fix-elixir-client-cache": {
    originalSha256: "79c1160ab9aa259f0c6403dc96379a7ea3160e5798a7dbf210ceba1ba0339533",
    search: "RUN mix deps.get \\",
    replacement: "RUN HEX_HTTP_CONCURRENCY=1 HEX_HTTP_TIMEOUT=120 mix deps.get \\",
    reason: "Hex timed out fetching the locked pg_query_ex-0.9.0 tarball; use Hex's own recommended low-concurrency timeout settings without changing dependency identity",
  },
});

const args = parseArgs(process.argv.slice(2));
const datasetRoot = resolve(required(args, "dataset"));
const taskId = required(args, "task");
const image = required(args, "image");
const recipe = RECIPES[taskId];
if (!recipe) throw new Error(`No audited environment-port recipe exists for ${taskId}`);
await assertPinnedSeniorDataset(datasetRoot);

const context = join(datasetRoot, "tasks", taskId, "environment");
const dockerfilePath = join(context, "Dockerfile");
const original = await readFile(dockerfilePath, "utf8");
const originalSha256 = sha256(original);
if (originalSha256 !== recipe.originalSha256) throw new Error(`Dockerfile hash mismatch for ${taskId}`);
if (original.split(recipe.search).length !== 2) throw new Error(`Expected exactly one audited replacement site for ${taskId}`);
const derived = original.replace(recipe.search, recipe.replacement);
const identity = {
  schemaVersion: "skillscope.senior-swe.environment-port.v1",
  taskId,
  datasetRoot,
  originalSha256,
  derivedSha256: sha256(derived),
  replacementSha256: sha256(`${recipe.search}\n=>\n${recipe.replacement}`),
  reason: recipe.reason,
  image,
  buildNetwork: "host",
};
process.stderr.write(`${JSON.stringify(identity, null, 2)}\n`);
if (args["print-identity"] === "true") process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);
else await dockerBuild({ context, image, dockerfile: derived });

function dockerBuild({ context, image: imageName, dockerfile }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", ["build", "--network", "host", "--pull=false", "-t", imageName, "-f", "-", context], { stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(dockerfile, "utf8");
    child.once("error", rejectPromise);
    child.once("close", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`docker build failed with exit code ${code}`)));
  });
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Arguments must be --key value pairs");
    result[key.slice(2)] = value;
  }
  return result;
}
function required(object, key) { if (!object[key]) throw new Error(`--${key} is required`); return object[key]; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
