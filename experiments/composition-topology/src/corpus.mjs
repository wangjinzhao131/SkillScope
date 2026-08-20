import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TASK_SCHEMA_VERSION, hashJson } from "./protocol.mjs";

const taskPath = fileURLToPath(new URL("../tasks/cases.json", import.meta.url));
const ROLES = ["constraint", "observation"];

export async function loadFamilies() {
  const parsed = JSON.parse(await readFile(taskPath, "utf8"));
  validateCorpus(parsed);
  return parsed.families.map((family) => Object.freeze(structuredClone(family)));
}

export function materializePackets(family, sentinel) {
  if (!/^COMPOSITION_SENTINEL_[A-F0-9]+$/u.test(sentinel)) throw new Error("sentinel must be a fresh uppercase hexadecimal composition marker");
  const constraintPath = `evidence/${family.id}-constraint.txt`;
  const observationPath = `evidence/${family.id}-observation.txt`;
  const constraint = packet("constraint", family.constraintPacket, sentinel, family.id);
  const observation = packet("observation", family.observationPacket, sentinel, family.id);
  return {
    constraintPath,
    observationPath,
    files: { [constraintPath]: constraint, [observationPath]: observation },
    bytes: Buffer.byteLength(constraint) + Buffer.byteLength(observation),
  };
}

export function validateCorpus(parsed) {
  if (!parsed || parsed.schemaVersion !== TASK_SCHEMA_VERSION || !Array.isArray(parsed.families) || parsed.families.length !== 6) throw new Error(`Task corpus must use ${TASK_SCHEMA_VERSION} with six families`);
  const ids = new Set();
  const directions = [];
  for (const family of parsed.families) {
    for (const key of ["id", "dependencyDirection", "question", "routingCue", "decisionRule", "expectedDecision", "constraintFact", "observationFact"]) {
      if (typeof family[key] !== "string" || family[key].length === 0) throw new Error(`${family.id ?? "family"}.${key} is required`);
    }
    if (!/^[a-z0-9-]+$/u.test(family.id) || ids.has(family.id)) throw new Error(`Invalid or duplicate family id ${family.id}`);
    ids.add(family.id);
    if (!["constraint-first", "observation-first", "independent"].includes(family.dependencyDirection)) throw new Error(`${family.id}.dependencyDirection is invalid`);
    if (!["ALLOW", "BLOCK"].includes(family.expectedDecision)) throw new Error(`${family.id}.expectedDecision is invalid`);
    directions.push(family.dependencyDirection);
    for (const role of ROLES) validatePacket(family[`${role}Packet`], role, family.id);
    const constraintTruth = expectedPacketValue(family.constraintPacket, family.observationPacket);
    const observationTruth = expectedPacketValue(family.observationPacket, family.constraintPacket);
    if (constraintTruth !== family.constraintFact || observationTruth !== family.observationFact) throw new Error(`${family.id} hidden facts do not match packet graph`);
  }
  for (const direction of ["constraint-first", "observation-first", "independent"]) if (directions.filter((value) => value === direction).length !== 2) throw new Error(`Corpus must contain two ${direction} families`);
  return true;
}

export function corpusHash(families) { return hashJson(families); }

function validatePacket(packetSpec, role, familyId) {
  if (!packetSpec || !["INDEPENDENT", "REQUIRES_UPSTREAM"].includes(packetSpec.mode)) throw new Error(`${familyId}.${role}Packet mode is invalid`);
  if (packetSpec.mode === "INDEPENDENT") {
    if (typeof packetSpec.primaryKey !== "string" || typeof packetSpec.primaryValue !== "string") throw new Error(`${familyId}.${role}Packet requires primaryKey/value`);
    if (packetSpec.entries !== undefined || packetSpec.requiredUpstreamRole !== undefined) throw new Error(`${familyId}.${role}Packet mixes packet modes`);
  } else {
    if (!ROLES.includes(packetSpec.requiredUpstreamRole) || packetSpec.requiredUpstreamRole === role) throw new Error(`${familyId}.${role}Packet upstream role is invalid`);
    if (!packetSpec.entries || Object.keys(packetSpec.entries).length !== 5 || Object.values(packetSpec.entries).some((value) => typeof value !== "string" || value.length === 0)) throw new Error(`${familyId}.${role}Packet must freeze five entries`);
    if (packetSpec.primaryKey !== undefined || packetSpec.primaryValue !== undefined) throw new Error(`${familyId}.${role}Packet mixes packet modes`);
  }
}

function expectedPacketValue(packetSpec, otherSpec) {
  if (packetSpec.mode === "INDEPENDENT") return packetSpec.primaryValue;
  if (otherSpec.mode !== "INDEPENDENT") throw new Error("Direction graph must have one independently resolvable packet");
  const value = packetSpec.entries[otherSpec.primaryKey];
  if (typeof value !== "string") throw new Error(`Missing entry for upstream key ${otherSpec.primaryKey}`);
  return value;
}

function packet(role, spec, sentinel, familyId) {
  const lines = [
    `PACKET_ROLE: ${role}`,
    `WORKFLOW_FAMILY: ${familyId}`,
    `RESOLUTION_MODE: ${spec.mode}`,
  ];
  if (spec.mode === "INDEPENDENT") {
    lines.push(`PRIMARY_KEY: ${spec.primaryKey}`, `PRIMARY_VALUE: ${spec.primaryValue}`);
  } else {
    lines.push(`REQUIRED_UPSTREAM_ROLE: ${spec.requiredUpstreamRole}`);
    for (const [key, value] of Object.entries(spec.entries)) lines.push(`ENTRY: ${key} => ${value}`);
  }
  lines.push("BEGIN_UNRELATED_WORK_LOG");
  for (let index = 1; index <= 100; index += 1) {
    const sequence = String(index).padStart(3, "0");
    lines.push(`worklog-${sequence} component=composition-aux-${index % 13} status=unchanged note=historical-record-not-valid-for-selection`);
    if (index === 50) lines.push(sentinel);
  }
  lines.push("END_UNRELATED_WORK_LOG", "END_PACKET", "");
  return lines.join("\n");
}
