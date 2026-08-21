import { createHash } from "node:crypto";

const ARTIFACT_REF = /^artifact:\/\/sha256\/[a-f0-9]{64}$/u;

/**
 * Trusted, content-addressed storage. Model-visible values are immutable handles;
 * artifact bodies are available only to the harness/environment boundary.
 */
export class ContentAddressedArtifactStore {
  #records = new Map();

  put(content, { kind = "patch", mediaType = "text/x-diff" } = {}) {
    if (typeof content !== "string" || content.length === 0) throw new Error("artifact content must be a non-empty string");
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const artifactRef = `artifact://sha256/${sha256}`;
    const bytes = Buffer.byteLength(content, "utf8");
    const existing = this.#records.get(artifactRef);
    if (existing && (existing.kind !== kind || existing.mediaType !== mediaType)) {
      throw new Error(`artifact metadata conflict for ${artifactRef}`);
    }
    this.#records.set(artifactRef, { content, kind, mediaType, bytes, sha256 });
    return Object.freeze({ artifactRef, sha256: `sha256:${sha256}`, bytes, kind, mediaType });
  }

  describe(artifactRef) {
    assertArtifactRef(artifactRef);
    const record = this.#records.get(artifactRef);
    if (!record) throw new Error(`unknown artifact ${artifactRef}`);
    return Object.freeze({
      artifactRef,
      sha256: `sha256:${record.sha256}`,
      bytes: record.bytes,
      kind: record.kind,
      mediaType: record.mediaType,
    });
  }

  /** Trusted use only. Never place this value in a model or parent projection. */
  read(artifactRef) {
    assertArtifactRef(artifactRef);
    const record = this.#records.get(artifactRef);
    if (!record) throw new Error(`unknown artifact ${artifactRef}`);
    return record.content;
  }

  get size() {
    return this.#records.size;
  }
}

export function assertArtifactHandle(handle) {
  if (!handle || typeof handle !== "object" || Array.isArray(handle)) throw new Error("artifact handle must be an object");
  assertArtifactRef(handle.artifactRef);
  if (!/^sha256:[a-f0-9]{64}$/u.test(handle.sha256)) throw new Error("artifact handle has invalid sha256");
  if (!Number.isSafeInteger(handle.bytes) || handle.bytes < 1) throw new Error("artifact handle has invalid bytes");
  if (typeof handle.kind !== "string" || typeof handle.mediaType !== "string") throw new Error("artifact handle metadata is incomplete");
}

function assertArtifactRef(value) {
  if (typeof value !== "string" || !ARTIFACT_REF.test(value)) throw new Error(`invalid artifact ref ${value}`);
}

