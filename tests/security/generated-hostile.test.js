import assert from "node:assert/strict";
import test from "node:test";

import {
  ResourceAccessError,
  ResourceBroker,
  normalizeResourcePath,
} from "../../src/core/index.js";

function expectCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof ResourceAccessError && error.code === code,
  );
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

test("seeded hostile path corpus stays fail-closed", (t) => {
  const random = xorshift32(0x5c0fe123);
  let invalidAttempts = 0;
  for (let index = 0; index < 1_024; index += 1) {
    const left = `s${random().toString(36)}`;
    const right = `t${random().toString(36)}`;
    const variants = [
      `${left}/../${right}`,
      `${left}/../../${right}`,
      `../${left}/${right}`,
      `/${left}/${right}`,
      `Z:${left}/${right}`,
      `${left}\\${right}`,
      `${left}\0${right}`,
    ];
    for (const path of variants) {
      expectCode(() => normalizeResourcePath(path), "INVALID_PATH");
      invalidAttempts += 1;
    }
  }
  assert.equal(invalidAttempts, 7_168);
  t.diagnostic(`${invalidAttempts} generated traversal/absolute/drive/separator paths rejected`);
});

test("seeded prefix-collision corpus never expands a directory grant", (t) => {
  const files = { "grant/allowed.txt": "allowed" };
  for (let index = 0; index < 1_024; index += 1) {
    files[`grant-${index.toString(36)}/secret.txt`] = `outside-${index}`;
  }
  const broker = new ResourceBroker({
    files,
    mode: "BOUNDED",
    grants: [{ path: "grant", kind: "directory", operations: ["read", "list", "search"] }],
    clock: () => 1_700_000_000_000,
  });

  let denied = 0;
  for (let index = 0; index < 1_024; index += 1) {
    const directory = `grant-${index.toString(36)}`;
    const operation = index % 3;
    if (operation === 0) expectCode(() => broker.read(`${directory}/secret.txt`), "UNAUTHORIZED");
    if (operation === 1) expectCode(() => broker.list(directory), "UNAUTHORIZED");
    if (operation === 2) expectCode(() => broker.search("outside", { path: directory }), "UNAUTHORIZED");
    denied += 1;
  }

  const snapshot = broker.snapshot();
  assert.equal(snapshot.counts.denials, denied);
  assert.equal(snapshot.counts.actualReadResources, 0);
  assert.equal(snapshot.counts.modelVisibleResources, 0);
  t.diagnostic(`${denied} generated prefix-collision operations denied before observation`);
});
