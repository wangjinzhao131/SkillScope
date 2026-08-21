#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const baseImage = required(args, "base-image");
const targetImage = required(args, "target-image");
const inspected = JSON.parse((await execFileAsync("docker", ["image", "inspect", baseImage], { encoding: "utf8" })).stdout)[0];
const dockerfile = [
  `FROM ${inspected.Id}`,
  "RUN python3 -m pip install --no-cache-dir 'requests>=2.28,<3.0' 'jinja2>=3.1,<4.0'",
  "",
].join("\n");
const identity = {
  schemaVersion: "skillscope.senior-swe.verifier-image.v1",
  baseImage,
  baseImageId: inspected.Id,
  targetImage,
  architecture: inspected.Architecture,
  addedDependencies: ["requests>=2.28,<3.0", "jinja2>=3.1,<4.0"],
  purpose: "public native runner import dependencies declared by upstream tests/test.sh; no tests or solution are embedded",
};
process.stderr.write(`${JSON.stringify(identity, null, 2)}\n`);
await build(dockerfile, targetImage);

function build(dockerfileText, image) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", ["build", "--network", "host", "--pull=false", "-t", image, "-"], { stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(dockerfileText, "utf8");
    child.once("error", rejectPromise);
    child.once("close", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`docker build failed with exit code ${code}`)));
  });
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]) throw new Error("Arguments must be --key value pairs");
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}
function required(object, key) { if (!object[key]) throw new Error(`--${key} is required`); return object[key]; }
