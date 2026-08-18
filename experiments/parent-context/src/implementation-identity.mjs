import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRoots = Object.freeze([
  "experiments/parent-context/src",
  "experiments/parent-context/tasks",
  "experiments/parent-context/README.md",
  "docs/research/父上下文与嵌套SkillScope实验预注册_v1.md",
  "src/core",
  "src/pi",
  "skills/inspect-constraint",
  "skills/inspect-observation",
  "skills/workflow-flat",
  "skills/workflow-main",
]);
const identityPaths = Object.freeze([...sourceRoots, "package.json", "package-lock.json"]);

export function captureImplementationIdentity({ allowDirty = false } = {}) {
  const implementationRevision = git(["rev-parse", "HEAD"]).trim();
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...identityPaths]).trim();
  if (dirty && !allowDirty) {
    throw Object.assign(new Error(`Outcome-relevant files are dirty: ${dirty.split("\n").slice(0, 12).join("; ")}`), { code: "IMPLEMENTATION_DIRTY" });
  }
  const entries = sourceRoots.flatMap(filesUnder).sort((a, b) => a.path.localeCompare(b.path));
  return Object.freeze({
    implementationRevision,
    sourceTreeHash: hashJson(entries),
    packageConfigHash: hashFile("package.json"),
    dependencyLockHash: hashFile("package-lock.json"),
    nodeVersion: process.version,
    implementationDirty: dirty.length > 0,
  });
}

export function projectRootPath() {
  return projectRoot;
}

function filesUnder(relativePath) {
  const absolute = resolve(projectRoot, relativePath);
  if (!existsSync(absolute)) throw new Error(`Missing identity path ${relativePath}`);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) throw new Error(`Identity path may not be a symlink: ${relativePath}`);
  if (info.isFile()) return [fileEntry(relativePath, absolute)];
  if (!info.isDirectory()) throw new Error(`Unsupported identity path ${relativePath}`);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relativePath}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Identity path may not be a symlink: ${child}`);
    if (entry.isDirectory()) return filesUnder(child);
    if (entry.isFile()) return [fileEntry(child, resolve(projectRoot, child))];
    throw new Error(`Unsupported identity entry ${child}`);
  });
}

function fileEntry(path, absolute) {
  const bytes = readFileSync(absolute);
  return { path: normalize(path), bytes: bytes.length, hash: hashBytes(bytes) };
}

function hashFile(path) {
  const absolute = resolve(projectRoot, path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) throw new Error(`Missing identity file ${path}`);
  return hashBytes(readFileSync(absolute));
}

function hashJson(value) {
  return hashBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalize(path) {
  return relative(projectRoot, resolve(projectRoot, path)).split(sep).join("/");
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`);
  }
}
