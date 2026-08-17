import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_MODES,
  ResourceAccessError,
  ResourceBroker,
  normalizeResourcePath,
} from "../../src/core/index.js";

const CANARY = "CANARY-OUTSIDE-GRANT-9f63";
const FILES = Object.freeze({
  "safe/allowed.txt": "allowed evidence",
  "safe/nested/info.txt": "nested evidence",
  "safe2/canary.txt": `do not reveal ${CANARY}`,
  "a.txt": "exact file",
  "a.txt.bak": "prefix collision backup",
  "unicode/caf\u00e9.txt": "NFC",
  "unicode/cafe\u0301.txt": "NFD",
  "unicode/\uff0e\uff0e/secret.txt": "fullwidth dots are literal",
  "encoded/%2e%2e/secret.txt": "literal percent encoding",
  "safe\uff0flookalike.txt": "fullwidth separator",
});

function expectCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof ResourceAccessError && error.code === code,
    `expected ResourceAccessError(${code})`,
  );
}

function bounded(grants, extra = {}) {
  return new ResourceBroker({
    files: FILES,
    mode: ACCESS_MODES.BOUNDED,
    grants,
    canaries: [{ id: "outside", value: CANARY }],
    clock: () => 1_700_000_000_000,
    ...extra,
  });
}

test("path normalization rejects traversal, absolute, drive, separator, and NUL attacks", () => {
  const hostilePaths = [
    "..",
    "../secret",
    "a/../../secret",
    "a/../b",
    "./../x",
    "/etc/passwd",
    "//server/share",
    "C:/secret",
    "C:\\secret",
    "C:secret",
    "\\\\server\\share",
    "safe\\file",
    "safe\0file",
  ];
  for (const path of hostilePaths) {
    expectCode(() => normalizeResourcePath(path), "INVALID_PATH");
  }

  assert.equal(normalizeResourcePath("./safe//nested/./info.txt"), "safe/nested/info.txt");
});

test("PROJECT expands valid project visibility but never bypasses path validation", () => {
  const broker = new ResourceBroker({ files: FILES, mode: "PROJECT_READ_ONLY" });
  assert.equal(broker.read("safe2/canary.txt").content.includes(CANARY), true);
  assert.equal(broker.search("literal", { path: "encoded" }).matches.length, 1);
  for (const path of ["../secret", "/tmp/secret", "C:\\secret", "safe\0file"]) {
    expectCode(() => broker.read(path), "INVALID_PATH");
  }
});

test("SEALED rejects read, list, and search even when broad grants were supplied", () => {
  const broker = new ResourceBroker({
    files: FILES,
    mode: ACCESS_MODES.SEALED,
    grants: [{ path: ".", kind: "directory", operations: ["read", "list", "search"] }],
  });
  expectCode(() => broker.read("safe/allowed.txt"), "SEALED");
  expectCode(() => broker.list("safe"), "SEALED");
  expectCode(() => broker.search("evidence", { path: "safe" }), "SEALED");
  expectCode(() => broker.read("../secret"), "INVALID_PATH");

  const snapshot = broker.snapshot();
  assert.equal(snapshot.counts.actualReadResources, 0);
  assert.equal(snapshot.counts.modelVisibleResources, 0);
  assert.deepEqual(snapshot.denials.map((denial) => denial.code), ["SEALED", "SEALED", "SEALED", "INVALID_PATH"]);
});

test("directory and file grants use path segments, not raw string prefixes", () => {
  const directoryBroker = bounded([
    { path: "safe", kind: "directory", operations: ["read", "list", "search"] },
  ]);
  assert.equal(directoryBroker.read("safe/allowed.txt").content, "allowed evidence");
  expectCode(() => directoryBroker.read("safe2/canary.txt"), "UNAUTHORIZED");
  expectCode(() => directoryBroker.list("safe2"), "UNAUTHORIZED");
  expectCode(() => directoryBroker.search(CANARY, { path: "safe2" }), "UNAUTHORIZED");
  expectCode(() => directoryBroker.read("safe\uff0flookalike.txt"), "UNAUTHORIZED");

  const fileBroker = bounded([
    { path: "a.txt", kind: "file", operations: ["read", "search"] },
  ]);
  assert.equal(fileBroker.read("a.txt").content, "exact file");
  expectCode(() => fileBroker.read("a.txt.bak"), "UNAUTHORIZED");
  expectCode(() => fileBroker.search("backup", { path: "a.txt.bak" }), "UNAUTHORIZED");
});

test("operation grants are independent for read, list, and search", () => {
  const operations = ["read", "list", "search"];
  for (const grantedOperation of operations) {
    const broker = bounded([
      { path: "safe", kind: "directory", operations: [grantedOperation] },
    ]);
    for (const attemptedOperation of operations) {
      const action = attemptedOperation === "read"
        ? () => broker.read("safe/allowed.txt")
        : attemptedOperation === "list"
          ? () => broker.list("safe")
          : () => broker.search("evidence", { path: "safe" });
      if (attemptedOperation === grantedOperation) {
        assert.doesNotThrow(action);
      } else {
        expectCode(action, "UNAUTHORIZED");
      }
    }
  }
});

test("denied paths are attempted and denied but never actual-read or model-visible", () => {
  const broker = bounded([
    { path: "safe", kind: "directory", operations: ["read", "list", "search"] },
  ]);
  broker.read("safe/allowed.txt");
  broker.list("safe", { recursive: true });
  broker.search("evidence", { path: "safe" });
  expectCode(() => broker.read("safe2/canary.txt"), "UNAUTHORIZED");
  expectCode(() => broker.list("safe2"), "UNAUTHORIZED");
  expectCode(() => broker.search(CANARY, { path: "safe2" }), "UNAUTHORIZED");

  const snapshot = broker.snapshot();
  assert(snapshot.attemptedSet.includes("safe2/canary.txt"));
  assert(snapshot.attemptedSet.includes("safe2"));
  assert.equal(snapshot.attemptedOperations.filter((attempt) => attempt.allowed === false).length, 3);
  assert.equal(snapshot.denials.length, 3);
  assert.equal(snapshot.actualReadSet.some((path) => path === "safe2" || path.startsWith("safe2/")), false);
  assert.equal(snapshot.modelVisibleSet.some((path) => path === "safe2" || path.startsWith("safe2/")), false);
  assert.deepEqual(snapshot.canaryVisibility, [{
    id: "outside",
    visible: false,
    hitCount: 0,
    sources: [],
    resourcePaths: [],
  }]);
});

test("audit snapshots redact canary values even when hostile callers place them in a path", () => {
  const broker = bounded([
    { path: "safe", kind: "directory", operations: ["read"] },
  ]);
  expectCode(() => broker.read(`safe2/${CANARY}.txt`), "UNAUTHORIZED");
  const serialized = JSON.stringify(broker.snapshot());
  assert.equal(serialized.includes(CANARY), false);
  assert.equal(serialized.includes("[CANARY:outside]"), true);
});

test("NFC, NFD, percent encoding, and lookalike separators remain distinct literal paths", () => {
  const nfc = "unicode/caf\u00e9.txt";
  const nfd = "unicode/cafe\u0301.txt";
  assert.notEqual(nfc, nfd);
  assert.equal(normalizeResourcePath(nfc), nfc);
  assert.equal(normalizeResourcePath(nfd), nfd);

  const unicodeBroker = bounded([
    { path: nfc, kind: "file", operations: ["read"] },
  ]);
  assert.equal(unicodeBroker.read(nfc).content, "NFC");
  expectCode(() => unicodeBroker.read(nfd), "UNAUTHORIZED");

  const encodedBroker = bounded([
    { path: "encoded", kind: "directory", operations: ["read"] },
  ]);
  assert.equal(encodedBroker.read("encoded/%2e%2e/secret.txt").content, "literal percent encoding");
  assert.equal(normalizeResourcePath("encoded/%252e%252e/secret.txt"), "encoded/%252e%252e/secret.txt");
  expectCode(() => encodedBroker.read("encoded/../secret.txt"), "INVALID_PATH");

  const unicodeDotBroker = bounded([
    { path: "unicode/\uff0e\uff0e", kind: "directory", operations: ["read"] },
  ]);
  assert.equal(unicodeDotBroker.read("unicode/\uff0e\uff0e/secret.txt").content, "fullwidth dots are literal");

  const lookalikeBroker = bounded([
    { path: "safe", kind: "directory", operations: ["read"] },
  ]);
  expectCode(() => lookalikeBroker.read("safe\uff0flookalike.txt"), "UNAUTHORIZED");
});

test("UTF-8 read limits never return more bytes than granted by maxBytes", () => {
  const broker = new ResourceBroker({
    files: { "safe/emoji.txt": "\ud83d\udca3secret" },
    mode: ACCESS_MODES.BOUNDED,
    grants: [{ path: "safe/emoji.txt", kind: "file", operations: ["read"] }],
    limits: { maxReadBytes: 4 },
  });
  for (const maxBytes of [1, 2, 3, 4]) {
    const result = broker.read("safe/emoji.txt", { maxBytes });
    assert(result.bytes <= maxBytes, `returned ${result.bytes} bytes for maxBytes=${maxBytes}`);
    assert.equal(result.content.includes("secret"), false);
  }
});

test("prompt snapshots stay visible in SEALED without becoming runtime read grants", () => {
  const broker = new ResourceBroker({
    files: FILES,
    mode: ACCESS_MODES.SEALED,
    promptRefs: [{ name: "explicit", path: "safe/allowed.txt" }],
  });
  assert.equal(broker.getPromptMaterials()[0].content, "allowed evidence");
  expectCode(() => broker.read("safe/allowed.txt"), "SEALED");
  const snapshot = broker.snapshot();
  assert.deepEqual(snapshot.modelVisibleSet, ["safe/allowed.txt"]);
  assert.deepEqual(snapshot.actualReadSet, []);
});

test("external Trace paths cannot be reached through PROJECT virtual-path tools", () => {
  const broker = new ResourceBroker({ files: FILES, mode: ACCESS_MODES.PROJECT });
  for (const guessedTracePath of [
    "/tmp/skillscope-traces/scope/manifest.json",
    "../skillscope-traces/scope/manifest.json",
  ]) {
    expectCode(() => broker.read(guessedTracePath), "INVALID_PATH");
  }
  expectCode(() => broker.read("scope/manifest.json"), "NOT_FOUND");
  assert.equal(broker.snapshot().modelVisibleSet.some((path) => path.includes("manifest.json")), false);
});

test("constructor snapshots virtual files and treats symlink-looking metadata as inert data", () => {
  const inputFiles = [{
    path: "safe/link",
    content: "ordinary virtual content",
    type: "symlink",
    target: "../../outside-secret",
  }];
  const grants = [{ path: "safe/link", kind: "file", operations: ["read"] }];
  const broker = new ResourceBroker({ files: inputFiles, mode: ACCESS_MODES.BOUNDED, grants });
  inputFiles[0].content = "mutated outside content";
  grants[0].path = "safe2/canary.txt";

  assert.equal(broker.read("safe/link").content, "ordinary virtual content");
  expectCode(() => broker.read("safe2/canary.txt"), "UNAUTHORIZED");
});

test("snapshots are defensive copies and cannot be used to expand grants", () => {
  const broker = bounded([
    { path: "safe", kind: "directory", operations: ["read"] },
  ]);
  const first = broker.snapshot();
  first.grantedSet[0].path = ".";
  first.grantedSet[0].operations.push("search");
  const second = broker.snapshot();
  assert.equal(second.grantedSet[0].path, "safe");
  assert.deepEqual(second.grantedSet[0].operations, ["read"]);
  expectCode(() => broker.read("safe2/canary.txt"), "UNAUTHORIZED");
});
