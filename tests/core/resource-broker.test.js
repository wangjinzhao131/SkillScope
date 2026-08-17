import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_MODES,
  ResourceAccessError,
  ResourceBroker,
  normalizeAccessMode,
  normalizeResourcePath,
} from "../../src/core/index.js";

const PROJECT_FILES = [
  { path: "src/auth/login.js", content: "export const login = true;\nneedle: auth", sensitivity: "public" },
  { path: "src/auth/token.js", content: "export const token = 'safe';", sensitivity: "public" },
  { path: "src/authz/policy.js", content: "OUTSIDE_CANARY\nneedle: policy", sensitivity: "canary" },
  { path: "docs/readme.md", content: "Documentation needle", sensitivity: "public" },
  { path: "empty.txt", content: "", sensitivity: "public" },
];

function bounded(options = {}) {
  return new ResourceBroker({
    files: PROJECT_FILES,
    mode: "BOUNDED",
    grants: [{
      path: "src/auth",
      kind: "directory",
      operations: ["read", "list", "search"],
    }],
    canaries: [{ id: "outside", value: "OUTSIDE_CANARY" }],
    clock: () => 123,
    ...options,
  });
}

function assertAccessCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ResourceAccessError);
    assert.equal(error.code, code);
    return true;
  });
}

test("normalizes POSIX relative paths without erasing traversal evidence", () => {
  assert.equal(normalizeResourcePath("./src//auth/./login.js"), "src/auth/login.js");
  assert.equal(normalizeResourcePath(""), ".");
  assert.equal(normalizeResourcePath("."), ".");

  for (const path of [
    "../secret",
    "src/../secret",
    "/etc/passwd",
    "C:/secret",
    "C:secret",
    "src\\secret",
    "src/\0secret",
  ]) {
    assertAccessCode(() => normalizeResourcePath(path), "INVALID_PATH");
  }
  assertAccessCode(() => normalizeResourcePath(".", { allowRoot: false }), "INVALID_PATH");
});

test("canonicalizes access mode aliases", () => {
  assert.equal(normalizeAccessMode("PROJECT_READ_ONLY"), ACCESS_MODES.PROJECT);
  assert.equal(normalizeAccessMode("bounded_oracle"), ACCESS_MODES.BOUNDED);
  assert.equal(normalizeAccessMode("BOUNDED_INFERRED"), ACCESS_MODES.BOUNDED);
  assert.equal(normalizeAccessMode("SEALED"), ACCESS_MODES.SEALED);
  assert.throws(() => normalizeAccessMode("OPEN"), /Unsupported/);
});

test("rejects normalized duplicate files and file/directory hierarchy collisions", () => {
  assert.throws(
    () => new ResourceBroker({ files: { "a//b.txt": "one", "a/b.txt": "two" } }),
    /Duplicate file/,
  );
  assert.throws(
    () => new ResourceBroker({ files: { a: "file", "a/b": "child" } }),
    /ancestor directory/,
  );
});

test("BOUNDED directory grant supports read, list, and search", () => {
  const broker = bounded();
  const read = broker.read("./src/auth//login.js", { startLine: 2, endLine: 2 });
  assert.deepEqual(read, {
    path: "src/auth/login.js",
    content: "needle: auth",
    startLine: 2,
    endLine: 2,
    totalLines: 2,
    bytes: 12,
    truncated: false,
  });

  assert.deepEqual(broker.list("src/auth").entries, [
    { path: "src/auth/login.js", name: "login.js", type: "file" },
    { path: "src/auth/token.js", name: "token.js", type: "file" },
  ]);
  assert.deepEqual(
    broker.search("needle", { path: "src/auth" }).matches.map((match) => match.path),
    ["src/auth/login.js"],
  );

  const snapshot = broker.snapshot();
  assert.deepEqual(snapshot.declaredSet, snapshot.grantedSet);
  assert.deepEqual(snapshot.actualReadSet, ["src/auth/login.js", "src/auth/token.js"]);
  assert.deepEqual(snapshot.modelVisibleSet, ["src/auth/login.js", "src/auth/token.js"]);
  assert.equal(snapshot.counts.attempts, 3);
  assert.equal(snapshot.counts.denials, 0);
});

test("segment-aware grants reject traversal, absolute paths, and prefix collisions", () => {
  const broker = bounded();
  assertAccessCode(() => broker.read("src/authz/policy.js"), "UNAUTHORIZED");
  assertAccessCode(() => broker.read("src/auth/../authz/policy.js"), "INVALID_PATH");
  assertAccessCode(() => broker.read("/src/auth/login.js"), "INVALID_PATH");

  const snapshot = broker.snapshot();
  assert.deepEqual(snapshot.attemptedSet, [
    "/src/auth/login.js",
    "src/auth/../authz/policy.js",
    "src/authz/policy.js",
  ]);
  assert.deepEqual(snapshot.denials.map((denial) => denial.code).sort(), [
    "INVALID_PATH",
    "INVALID_PATH",
    "UNAUTHORIZED",
  ]);
  assert.deepEqual(snapshot.actualReadSet, []);
  assert.equal(snapshot.canaryVisibility[0].visible, false);
});

test("authorization precedes existence checks and prevents existence leaks", () => {
  const broker = bounded();
  assertAccessCode(() => broker.read("secret/does-not-exist.txt"), "UNAUTHORIZED");
  assertAccessCode(() => broker.read("src/auth/does-not-exist.txt"), "NOT_FOUND");
});

test("SEALED keeps prompt snapshots visible but rejects every resource tool", () => {
  const broker = new ResourceBroker({
    files: PROJECT_FILES,
    mode: "SEALED",
    grants: [{ path: ".", kind: "directory", operations: ["read", "list", "search"] }],
    canaries: { id: "prompt", value: "PROMPT_CANARY" },
    promptRefs: [{ name: "input", content: "Visible PROMPT_CANARY", sourcePath: "docs/readme.md" }],
    clock: () => 1,
  });

  assertAccessCode(() => broker.read("docs/readme.md"), "SEALED");
  assertAccessCode(() => broker.list("."), "SEALED");
  assertAccessCode(() => broker.search("needle", { path: "." }), "SEALED");
  assert.equal(broker.getPromptMaterials()[0].content, "Visible PROMPT_CANARY");

  const snapshot = broker.snapshot();
  assert.deepEqual(snapshot.grantedSet, []);
  assert.deepEqual(snapshot.modelVisibleSet, ["docs/readme.md"]);
  assert.equal(snapshot.canaryVisibility[0].visible, true);
  assert.deepEqual(snapshot.canaryVisibility[0].sources, ["prompt:input"]);
  assert.deepEqual(snapshot.denials.map(({ code }) => code), ["SEALED", "SEALED", "SEALED"]);
});

test("PROJECT exposes the complete virtual project and records a root grant", () => {
  const broker = new ResourceBroker({ files: PROJECT_FILES, mode: "PROJECT_READ_ONLY" });
  assert.equal(broker.read("docs/readme.md").content, "Documentation needle");
  assert.equal(broker.search("policy", { path: "." }).matches[0].path, "src/authz/policy.js");
  assert.deepEqual(broker.snapshot().grantedSet, [{
    path: ".",
    kind: "directory",
    operations: ["read", "list", "search"],
  }]);
});

test("granted capabilities must be a subset of declared policy", () => {
  assert.throws(
    () => new ResourceBroker({
      files: PROJECT_FILES,
      mode: "BOUNDED",
      declaredGrants: [{ path: "src/auth", kind: "directory", operations: ["read"] }],
      grants: [{ path: "src", kind: "directory", operations: ["read"] }],
    }),
    /outside declared policy/,
  );
  assert.throws(
    () => new ResourceBroker({
      files: PROJECT_FILES,
      mode: "BOUNDED",
      declaredGrants: [{ path: "src/auth", kind: "directory", operations: ["read"] }],
      grants: [{ path: "src/auth", kind: "directory", operations: ["read", "search"] }],
    }),
    /outside declared policy/,
  );
});

test("file grants are exact and cannot carry list permission", () => {
  const broker = new ResourceBroker({
    files: PROJECT_FILES,
    mode: "BOUNDED",
    grants: [{ path: "src/auth/login.js", kind: "file", operations: ["read", "search"] }],
  });
  assert.equal(broker.read("src/auth/login.js").path, "src/auth/login.js");
  assertAccessCode(() => broker.read("src/auth/token.js"), "UNAUTHORIZED");
  assertAccessCode(() => broker.list("src/auth"), "UNAUTHORIZED");

  assert.throws(
    () => new ResourceBroker({
      files: PROJECT_FILES,
      grants: [{ path: "src/auth/login.js", kind: "file", operations: ["list"] }],
    }),
    /cannot grant list on a file/,
  );
});

test("list returns deterministic immediate or recursive entries", () => {
  const broker = new ResourceBroker({ files: PROJECT_FILES, mode: "PROJECT" });
  assert.deepEqual(broker.list("src").entries, [
    { path: "src/auth", name: "auth", type: "directory" },
    { path: "src/authz", name: "authz", type: "directory" },
  ]);
  assert.deepEqual(broker.list("src", { recursive: true }).entries, [
    { path: "src/auth", name: "auth", type: "directory" },
    { path: "src/auth/login.js", name: "auth/login.js", type: "file" },
    { path: "src/auth/token.js", name: "auth/token.js", type: "file" },
    { path: "src/authz", name: "authz", type: "directory" },
    { path: "src/authz/policy.js", name: "authz/policy.js", type: "file" },
  ]);
  assertAccessCode(() => broker.list("src/auth/login.js"), "NOT_A_DIRECTORY");
});

test("search is literal, deterministic, bounded, and supports case folding", () => {
  const broker = new ResourceBroker({
    files: {
      "a.txt": "Needle needle.* needle",
      "b.txt": "NEEDLE",
    },
    mode: "PROJECT",
    limits: { maxSearchResults: 3 },
  });
  const literal = broker.search("needle.*", { path: "." });
  assert.equal(literal.matches.length, 1);
  assert.equal(literal.matches[0].column, 8);

  const folded = broker.search("needle", { path: ".", caseSensitive: false, maxResults: 2 });
  assert.equal(folded.matches.length, 2);
  assert.equal(folded.truncated, true);
  assert.deepEqual(folded.matches.map((match) => match.path), ["a.txt", "a.txt"]);
});

test("search separates resources scanned from content returned to the model", () => {
  const broker = new ResourceBroker({
    files: {
      "allowed/a.txt": "ordinary text",
      "allowed/b.txt": "HIDDEN_IN_SCAN",
    },
    mode: "BOUNDED",
    grants: [{ path: "allowed", kind: "directory", operations: ["search"] }],
    canaries: [{ id: "scan", value: "HIDDEN_IN_SCAN" }],
  });
  assert.deepEqual(broker.search("missing", { path: "allowed" }).matches, []);
  const snapshot = broker.snapshot();
  assert.deepEqual(snapshot.actualReadSet, ["allowed/a.txt", "allowed/b.txt"]);
  assert.deepEqual(snapshot.modelVisibleSet, []);
  assert.equal(snapshot.canaryVisibility[0].visible, false);
});

test("read enforces line and byte limits without emitting broken UTF-8", () => {
  const broker = new ResourceBroker({
    files: { "unicode.txt": "💣bomb\nsecond" },
    mode: "PROJECT",
    limits: { maxReadBytes: 5 },
  });
  const oneByte = broker.read("unicode.txt", { maxBytes: 1 });
  assert.equal(oneByte.content, "");
  assert.equal(oneByte.bytes, 0);
  assert.equal(oneByte.truncated, true);

  const fiveBytes = broker.read("unicode.txt", { maxBytes: 5 });
  assert.equal(fiveBytes.content, "💣b");
  assert.equal(fiveBytes.bytes, 5);
  assert.equal(fiveBytes.truncated, true);
});

test("operation aliases are accepted but traces and grants are canonical", () => {
  const broker = new ResourceBroker({
    files: { "src/a.txt": "needle" },
    mode: "BOUNDED_ORACLE",
    grants: [{ path: "src", kind: "directory", operations: ["read", "grep", "find", "ls"] }],
  });
  assert.equal(broker.execute("grep", { query: "needle", path: "src" }).matches.length, 1);
  assert.equal(broker.execute("find", { path: "src" }).recursive, true);
  assert.equal(broker.execute("ls", { path: "src" }).recursive, false);

  const snapshot = broker.snapshot();
  assert.deepEqual(snapshot.grantedSet[0].operations, ["read", "list", "search"]);
  assert.deepEqual(
    snapshot.attemptedOperations.map(({ operation }) => operation).sort(),
    ["list", "list", "search"],
  );
});

test("Canary tracking observes prompt and tool boundaries but never stores values in traces", () => {
  const token = "TRACE_SECRET_1842";
  const broker = new ResourceBroker({
    files: {
      [`safe/${token}.txt`]: token,
      "safe/clean.txt": "clean",
    },
    mode: "BOUNDED",
    grants: [{ path: "safe", kind: "directory", operations: ["read", "list", "search"] }],
    canaries: { trace: token },
  });
  broker.list("safe");
  broker.read(`safe/${token}.txt`);
  assertAccessCode(() => broker.read(`outside/${token}`), "UNAUTHORIZED");

  const snapshot = broker.snapshot();
  assert.equal(snapshot.canaryVisibility[0].visible, true);
  assert.ok(snapshot.canaryVisibility[0].hitCount >= 2);
  assert.equal(JSON.stringify(snapshot).includes(token), false);
  assert.match(JSON.stringify(snapshot), /\[CANARY:trace\]/);
});

test("path-based and inline promptRefs produce immutable visible snapshots", () => {
  const broker = new ResourceBroker({
    files: { "log.txt": "one\ntwo\nthree" },
    mode: "SEALED",
    promptRefs: [
      { path: "log.txt", startLine: 2, endLine: 3, purpose: "failure" },
      { name: "question", content: "What happened?" },
    ],
  });
  const materials = broker.getPromptMaterials();
  assert.deepEqual(materials, [
    {
      name: "log.txt",
      sourcePath: "log.txt",
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
      purpose: "failure",
    },
    { name: "question", content: "What happened?" },
  ]);
  materials[0].content = "mutated";
  assert.equal(broker.getPromptMaterials()[0].content, "two\nthree");
  assert.deepEqual(broker.snapshot().modelVisibleSources, ["prompt:log.txt", "prompt:question"]);
});

test("recordModelVisibility lets an adapter mark transformed external messages", () => {
  const broker = bounded();
  const result = broker.recordModelVisibility(
    { excerpt: "OUTSIDE_CANARY" },
    { source: "adapter:message", resourcePaths: ["src/authz/policy.js"] },
  );
  assert.deepEqual(result.canaryIds, ["outside"]);
  const snapshot = broker.snapshot();
  assert.deepEqual(snapshot.modelVisibleSet, ["src/authz/policy.js"]);
  assert.equal(snapshot.canaryVisibility[0].visible, true);
});

test("snapshots are defensive copies and events use monotonic unique sequence ids", () => {
  const broker = bounded();
  broker.read("src/auth/login.js");
  assertAccessCode(() => broker.read("docs/readme.md"), "UNAUTHORIZED");
  const first = broker.snapshot();
  first.events.length = 0;
  first.grantedSet[0].operations.length = 0;
  const second = broker.snapshot();
  assert.ok(second.events.length > 0);
  assert.deepEqual(second.grantedSet[0].operations, ["read", "list", "search"]);
  const sequences = second.events.map((event) => event.sequence);
  assert.deepEqual(sequences, [...new Set(sequences)]);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);
});
