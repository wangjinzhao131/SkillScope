import { randomBytes } from "node:crypto";
import { CONDITIONS, MODEL, PARENT_BUDGET, PROTOCOL_VERSION, REPEATS, freshToken, hashJson, seededShuffle } from "./protocol.mjs";
import { captureImplementationIdentity } from "./implementation-identity.mjs";
import { corpusHash, loadFamilies, materializePackets } from "./corpus.mjs";

export async function buildManifest({ allowDirty = false, repeats = REPEATS, createdAt = new Date().toISOString() } = {}) {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  const identity = captureImplementationIdentity({ allowDirty });
  const families = await loadFamilies();
  const jobs = [];
  for (const family of families) for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const seed = randomBytes(4).readUInt32LE(0);
    const sentinel = freshToken("COMPOSITION_SENTINEL").toUpperCase();
    const memoryCode = freshToken("MEMORY").toUpperCase();
    const packets = materializePackets(family, sentinel);
    const blockId = `${family.id}:r${repeat}`;
    const ordered = seededShuffle(CONDITIONS, `${blockId}:${seed}`);
    for (let order = 0; order < ordered.length; order += 1) {
      const condition = ordered[order];
      const frozen = {
        protocolVersion: PROTOCOL_VERSION,
        condition,
        blockId,
        familyId: family.id,
        repeat,
        order,
        seed,
        memoryCode,
        sentinel,
        family,
        packets,
        model: MODEL,
        parentBudget: PARENT_BUDGET,
        externalRetryLimit: 1,
        identity,
      };
      jobs.push({ jobId: hashJson(frozen), ...frozen });
    }
  }
  const body = {
    schemaVersion: "composition-topology.manifest.v1",
    protocolVersion: PROTOCOL_VERSION,
    createdAt,
    model: MODEL,
    repeats,
    conditionCount: CONDITIONS.length,
    familyCount: families.length,
    jobCount: jobs.length,
    corpusHash: corpusHash(families),
    identity,
    jobs,
  };
  return { manifestHash: hashJson(body), ...body };
}

export function validateManifest(manifest, { requireClean = true } = {}) {
  if (!manifest || manifest.schemaVersion !== "composition-topology.manifest.v1" || manifest.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Manifest must use ${PROTOCOL_VERSION}`);
  if (!Array.isArray(manifest.jobs) || manifest.jobs.length !== manifest.familyCount * manifest.repeats * CONDITIONS.length) throw new Error("Manifest job matrix is incomplete");
  if (requireClean && manifest.identity?.implementationDirty !== false) throw new Error("Live manifest must be based on a clean implementation");
  const body = { ...manifest }; delete body.manifestHash;
  if (hashJson(body) !== manifest.manifestHash) throw new Error("Manifest hash mismatch");
  const ids = new Set();
  const blocks = new Map();
  for (const job of manifest.jobs) {
    if (ids.has(job.jobId)) throw new Error(`Duplicate job ${job.jobId}`);
    ids.add(job.jobId);
    const frozen = { ...job }; delete frozen.jobId;
    if (hashJson(frozen) !== job.jobId) throw new Error(`Job identity mismatch for ${job.blockId}/${job.condition}`);
    if (!CONDITIONS.includes(job.condition)) throw new Error(`Unknown condition ${job.condition}`);
    const shared = hashJson({ family: job.family, packets: job.packets, seed: job.seed, memoryCode: job.memoryCode, sentinel: job.sentinel });
    const prior = blocks.get(job.blockId);
    if (prior && prior !== shared) throw new Error(`Block ${job.blockId} does not share task bytes and seed`);
    blocks.set(job.blockId, shared);
  }
  for (const blockId of blocks.keys()) {
    const conditions = manifest.jobs.filter((job) => job.blockId === blockId).map((job) => job.condition).sort();
    if (JSON.stringify(conditions) !== JSON.stringify([...CONDITIONS].sort())) throw new Error(`Block ${blockId} is not a four-arm pair`);
  }
  return true;
}
