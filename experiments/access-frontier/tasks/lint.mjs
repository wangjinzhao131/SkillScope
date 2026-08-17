#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Check, Errors } from "typebox/value";
import { validateResponseContractDefinition } from "./response-contract.mjs";
import { promptRefCoversAssertion, validatePromptRefProvenance } from "./prompt-provenance.mjs";

const taskRoot = path.dirname(new URL(import.meta.url).pathname);
const casesRoot = path.join(taskRoot, "cases");
const schema = JSON.parse(
  await fs.readFile(path.join(taskRoot, "task.schema.json"), "utf8"),
);

const failures = [];
const fail = (taskId, message) => failures.push(`${taskId}: ${message}`);
const caseNames = (await fs.readdir(casesRoot))
  .filter((name) => name.endsWith(".json"))
  .sort();
const fixtures = [];

for (const caseName of caseNames) {
  const casePath = path.join(casesRoot, caseName);
  let fixture;
  try {
    fixture = JSON.parse(await fs.readFile(casePath, "utf8"));
  } catch (error) {
    fail(caseName, `invalid JSON: ${error.message}`);
    continue;
  }

  if (!Check(schema, fixture)) {
    for (const error of [...Errors(schema, fixture)]) {
      fail(caseName, `schema ${error.instancePath || "/"}: ${error.message}`);
    }
    continue;
  }

  const task = fixture.task;
  fixtures.push(task);
  if (`${task.id}.json` !== caseName) {
    fail(task.id, `filename must be ${task.id}.json, got ${caseName}`);
  }

  for (const error of validateResponseContractDefinition(task.responseContract, {
    expectedAnswer: task.expectedAnswer,
    decoyAnswerCode: task.canary?.decoyAnswerCode,
  })) {
    fail(task.id, `response contract: ${error}`);
  }

  const files = new Map();
  for (const file of task.virtualProject.files) {
    if (files.has(file.path)) fail(task.id, `duplicate virtual file ${file.path}`);
    files.set(file.path, file);
  }

  const resourceExists = (resourcePath, kind) =>
    kind === "file"
      ? files.has(resourcePath)
      : [...files.keys()].some((filePath) =>
          filePath.startsWith(resourcePath.endsWith("/") ? resourcePath : `${resourcePath}/`),
        );
  const grantCovers = (grant, filePath) =>
    grant.kind === "file"
      ? grant.path === filePath
      : filePath.startsWith(grant.path.endsWith("/") ? grant.path : `${grant.path}/`);

  for (const promptRef of task.promptRefs) {
    if (!promptRef.sourcePath) continue;
    const source = files.get(promptRef.sourcePath);
    if (!source) {
      fail(task.id, `promptRef ${promptRef.name} source does not exist: ${promptRef.sourcePath}`);
    } else {
      for (const error of validatePromptRefProvenance(promptRef, source.content)) {
        fail(task.id, `promptRef ${promptRef.name}: ${error}`);
      }
    }
  }

  for (const grant of task.oracleGrants) {
    if (!resourceExists(grant.path, grant.kind)) {
      fail(task.id, `oracle grant points to missing ${grant.kind}: ${grant.path}`);
    }
  }
  for (const entry of task.inferredCatalog) {
    if (!resourceExists(entry.path, entry.kind)) {
      fail(task.id, `catalog entry points to missing ${entry.kind}: ${entry.path}`);
    }
  }

  const requiredPaths = new Set(task.requiredEvidence);
  for (const requiredPath of requiredPaths) {
    if (!files.has(requiredPath)) {
      fail(task.id, `required evidence does not exist: ${requiredPath}`);
    }
    if (!task.oracleGrants.some((grant) => grantCovers(grant, requiredPath))) {
      fail(task.id, `oracle grants do not cover required evidence: ${requiredPath}`);
    }
    if (!task.evidenceAssertions.some((assertion) => assertion.path === requiredPath)) {
      fail(task.id, `required evidence has no line assertion: ${requiredPath}`);
    }
  }

  const evidenceIds = new Set();
  for (const assertion of task.evidenceAssertions) {
    if (evidenceIds.has(assertion.id)) fail(task.id, `duplicate evidence id ${assertion.id}`);
    evidenceIds.add(assertion.id);
    if (!requiredPaths.has(assertion.path)) {
      fail(task.id, `evidence assertion path is not required: ${assertion.path}`);
    }
    const evidenceFile = files.get(assertion.path);
    if (!evidenceFile) continue;
    const lines = evidenceFile.content.split("\n");
    if (assertion.startLine > assertion.endLine) {
      fail(task.id, `${assertion.id} startLine exceeds endLine`);
      continue;
    }
    if (assertion.endLine > lines.length) {
      fail(task.id, `${assertion.id} endLine ${assertion.endLine} exceeds ${lines.length}`);
      continue;
    }
    const span = lines.slice(assertion.startLine - 1, assertion.endLine).join("\n");
    if (!span.includes(assertion.contains)) {
      fail(task.id, `${assertion.id} declared span does not contain ${JSON.stringify(assertion.contains)}`);
    }
  }

  const coveredAssertions = task.evidenceAssertions.filter((assertion) =>
    task.promptRefs.some((promptRef) => promptRefCoversAssertion(promptRef, assertion)),
  ).length;
  const measuredCoverage = coveredAssertions / task.evidenceAssertions.length;
  if (Math.abs(measuredCoverage - task.axes.initialEvidenceCoverage) > 1e-9) {
    fail(
      task.id,
      `initialEvidenceCoverage is ${task.axes.initialEvidenceCoverage}, measured ${measuredCoverage}`,
    );
  }

  const canaryFile = files.get(task.canary.path);
  if (!canaryFile) {
    fail(task.id, `canary file does not exist: ${task.canary.path}`);
  } else {
    const occurrences = canaryFile.content.split(task.canary.tokenPlaceholder).length - 1;
    if (occurrences !== 1) {
      fail(task.id, `canary placeholder must occur exactly once, found ${occurrences}`);
    }
    if (canaryFile.sensitivity !== "canary") {
      fail(task.id, `canary file sensitivity must be canary`);
    }
  }
  if (task.oracleGrants.some((grant) => grantCovers(grant, task.canary.path))) {
    fail(task.id, `bounded Oracle grant covers Canary ${task.canary.path}`);
  }
}

const ids = new Set();
for (const task of fixtures) {
  if (ids.has(task.id)) fail(task.id, "duplicate task id");
  ids.add(task.id);
}
if (fixtures.length < 12) fail("corpus", `requires at least 12 tasks, found ${fixtures.length}`);

const pairs = Map.groupBy(fixtures, (task) => task.pairId);
for (const [pairId, tasks] of pairs) {
  if (tasks.length !== 2) fail(pairId, `expected exactly 2 variants, found ${tasks.length}`);
  if (tasks.length === 2 && !isDeepStrictEqual(tasks[0].expectedAnswer, tasks[1].expectedAnswer)) {
    fail(pairId, "paired variants must have identical expectedAnswer objects");
  }
  if (tasks.length === 2 && !isDeepStrictEqual(tasks[0].responseContract, tasks[1].responseContract)) {
    fail(pairId, "paired variants must have identical public responseContract objects");
  }
  if (new Set(tasks.map((task) => task.variant)).size !== tasks.length) {
    fail(pairId, "paired variants must have distinct variant labels");
  }
}

const axisValues = (name) => new Set(fixtures.map((task) => task.axes[name]));
const requiredAxisLevels = {
  initialEvidenceCoverage: [0, 1],
  evidenceDispersion: ["single-file", "cross-directory"],
  searchEntropy: ["low", "high"],
  conflictingInformation: ["none", "in-grant", "out-of-grant"],
  promptInjection: ["none", "in-grant", "out-of-grant"],
  outOfGrantCanary: [true],
  grantGranularity: ["file", "directory"],
};
for (const [axis, levels] of Object.entries(requiredAxisLevels)) {
  const observed = axisValues(axis);
  for (const level of levels) {
    if (!observed.has(level)) fail("corpus", `axis ${axis} is missing level ${String(level)}`);
  }
}

if (failures.length > 0) {
  console.error(`Fixture lint failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Fixture lint passed: ${fixtures.length} tasks across ${pairs.size} counterfactual pairs.`);
}
