import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const IMPLEMENTATION_IDENTITY_FIELDS = Object.freeze([
  "implementationRevision",
  "sourceTreeHash",
  "dependencyLockHash",
  "packageConfigHash",
  "nodeVersion",
  "implementationDirty",
]);

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRoots = Object.freeze([
  "experiments/access-frontier/src",
  "experiments/access-frontier/analysis",
  "experiments/access-frontier/tasks/task.schema.json",
  "experiments/access-frontier/tasks/lint.mjs",
  "experiments/access-frontier/tasks/cases",
  "experiments/access-frontier/tasks/response-contract.mjs",
  "experiments/access-frontier/tasks/prompt-provenance.mjs",
  "docs/research/访问边界实验预注册_v2.md",
  "experiments/access-frontier/entropy-frontier/executor.mjs",
  "experiments/access-frontier/entropy-frontier/entropy-frontier.v1.json",
  "docs/research/高搜索熵访问实验预注册_v1.md",
  "experiments/access-frontier/entropy-frontier/planner-budget-probe.mjs",
  "docs/research/Planner输出预算实验预注册_v1.md",
  "experiments/access-frontier/resource-set-holdout/executor.mjs",
  "experiments/access-frontier/resource-set-holdout/resource-set-holdout.v1.json",
  "docs/research/ResourceSet真实仓库快照实验预注册_v1.md",
  "src/core",
]);
const dependencyLockPath = "package-lock.json";
const packageConfigPath = "package.json";
const gitIdentityPaths = Object.freeze([
  ...sourceRoots,
  dependencyLockPath,
  packageConfigPath,
]);

export function captureImplementationIdentity({ allowDirty = true } = {}) {
  const implementationRevision = git(["rev-parse", "HEAD"]).trim();
  const dirtyOutput = git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...gitIdentityPaths,
  ]).trim();
  const implementationDirty = dirtyOutput.length > 0;
  if (implementationDirty && !allowDirty) {
    const paths = dirtyOutput.split("\n").slice(0, 12).join("; ");
    throw Object.assign(
      new Error(`Outcome-relevant implementation files are dirty (${paths}). Commit them or use --allow-dirty for an engineering-only manifest.`),
      { code: "IMPLEMENTATION_DIRTY" },
    );
  }

  const sourceEntries = sourceRoots.flatMap(filesUnder).sort((a, b) => a.path.localeCompare(b.path));
  if (sourceEntries.length === 0) throw new Error("Implementation source inventory is empty");
  return Object.freeze({
    implementationRevision,
    sourceTreeHash: hashJson(sourceEntries),
    dependencyLockHash: hashRequiredFile(dependencyLockPath),
    packageConfigHash: hashRequiredFile(packageConfigPath),
    nodeVersion: process.version,
    implementationDirty,
  });
}

export function implementationIdentityFrom(record) {
  return Object.fromEntries(IMPLEMENTATION_IDENTITY_FIELDS.map((field) => [field, record?.[field]]));
}

function filesUnder(relativePath) {
  const absolutePath = resolve(projectRoot, relativePath);
  if (!existsSync(absolutePath)) throw new Error(`Missing implementation identity path: ${relativePath}`);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) throw new Error(`Implementation identity path may not be a symlink: ${relativePath}`);
  if (stat.isFile()) return [fileEntry(relativePath, absolutePath)];
  if (!stat.isDirectory()) throw new Error(`Unsupported implementation identity entry: ${relativePath}`);
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const childRelative = `${relativePath}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Implementation source may not be a symlink: ${childRelative}`);
    if (entry.isDirectory()) return filesUnder(childRelative);
    if (!entry.isFile()) throw new Error(`Unsupported implementation source entry: ${childRelative}`);
    return [fileEntry(childRelative, resolve(projectRoot, childRelative))];
  });
}

function fileEntry(relativePath, absolutePath) {
  const bytes = readFileSync(absolutePath);
  return {
    path: normalizeRelativePath(relativePath),
    bytes: bytes.length,
    hash: hashBytes(bytes),
  };
}

function hashRequiredFile(relativePath) {
  const absolutePath = resolve(projectRoot, relativePath);
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
    throw new Error(`Missing required reproducibility file: ${relativePath}`);
  }
  return hashBytes(readFileSync(absolutePath));
}

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashJson(value) {
  return hashBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function normalizeRelativePath(value) {
  return relative(projectRoot, resolve(projectRoot, value)).split(sep).join("/");
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(`Cannot capture implementation identity with git ${args.join(" ")}: ${detail}`);
  }
}
