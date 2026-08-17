import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonSchema, LoadedSkill, SkillBudget, SkillSpec } from "./contracts.js";
import { validateSupportedJsonSchema } from "./json-schema.js";

const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL_NAMES = new Set(["scope_read", "scope_list", "scope_search"]);
const ACCESS_MODES = new Set(["SEALED", "BOUNDED", "PROJECT"]);
const OPERATIONS = new Set(["read", "list", "search"]);

export class SkillRegistry {
  readonly skillsRoot: string;

  constructor(skillsRoot: string) {
    this.skillsRoot = resolve(skillsRoot);
  }

  async load(name: string): Promise<LoadedSkill> {
    if (!SKILL_NAME.test(name)) throw new SkillRegistryError("INVALID_SKILL_NAME", `Invalid skill name: ${name}`);

    const root = await realpath(this.skillsRoot);
    const directory = await realpath(resolve(root, name)).catch(() => {
      throw new SkillRegistryError("SKILL_NOT_FOUND", `Scoped skill is not installed: ${name}`);
    });
    assertDescendant(root, directory, "Skill directory escapes the configured skills root");

    const manifestPath = resolve(directory, "scope.json");
    const manifest = parseJson(await readFile(manifestPath, "utf8"), manifestPath);
    const spec = parseSkillSpec(manifest, manifestPath);
    if (spec.name !== name) {
      throw new SkillRegistryError("SKILL_NAME_MISMATCH", `Requested ${name}, but scope.json declares ${spec.name}`);
    }

    if (isAbsolute(spec.promptFile)) throw new SkillRegistryError("INVALID_PROMPT_FILE", "promptFile must be relative");
    const promptPath = await realpath(resolve(directory, spec.promptFile));
    assertDescendant(directory, promptPath, "promptFile escapes its skill directory");
    const instructions = await readFile(promptPath, "utf8");

    return { ...spec, directory, instructions };
  }
}

export class SkillRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillRegistryError";
    this.code = code;
  }
}

function parseSkillSpec(value: unknown, source: string): SkillSpec {
  const manifest = requireRecord(value, source);
  const resourcePolicy = requireRecord(manifest.resourcePolicy, `${source}#resourcePolicy`);
  const budgetRecord = requireRecord(manifest.budget, `${source}#budget`);
  const allowedTools = requireStringArray(manifest.allowedTools, "allowedTools");
  const allowedAccessModes = requireStringArray(resourcePolicy.allowedAccessModes, "resourcePolicy.allowedAccessModes");
  const allowedOperations = requireStringArray(resourcePolicy.allowedOperations, "resourcePolicy.allowedOperations");

  for (const tool of allowedTools) if (!TOOL_NAMES.has(tool)) throw new SkillRegistryError("INVALID_MANIFEST", `Unsupported allowed tool: ${tool}`);
  for (const mode of allowedAccessModes) if (!ACCESS_MODES.has(mode)) throw new SkillRegistryError("INVALID_MANIFEST", `Unsupported access mode: ${mode}`);
  for (const operation of allowedOperations) if (!OPERATIONS.has(operation)) throw new SkillRegistryError("INVALID_MANIFEST", `Unsupported resource operation: ${operation}`);

  const defaultAccessMode = requireString(resourcePolicy.defaultAccessMode, "resourcePolicy.defaultAccessMode");
  if (!allowedAccessModes.includes(defaultAccessMode)) {
    throw new SkillRegistryError("INVALID_MANIFEST", "defaultAccessMode must appear in allowedAccessModes");
  }

  const inputSchema = requireRecord(manifest.inputSchema, "inputSchema") as JsonSchema;
  const outputSchema = requireRecord(manifest.outputSchema, "outputSchema") as JsonSchema;
  assertSupportedSchema(inputSchema, "inputSchema");
  assertSupportedSchema(outputSchema, "outputSchema");

  return {
    name: requireString(manifest.name, "name"),
    version: requireString(manifest.version, "version"),
    description: requireString(manifest.description, "description"),
    promptFile: requireString(manifest.promptFile, "promptFile"),
    inputSchema,
    outputSchema,
    allowedTools: allowedTools as SkillSpec["allowedTools"],
    resourcePolicy: {
      defaultAccessMode: defaultAccessMode as SkillSpec["resourcePolicy"]["defaultAccessMode"],
      allowedAccessModes: allowedAccessModes as SkillSpec["resourcePolicy"]["allowedAccessModes"],
      allowedOperations: allowedOperations as SkillSpec["resourcePolicy"]["allowedOperations"],
    },
    budget: parseBudget(budgetRecord),
  };
}

function assertSupportedSchema(schema: JsonSchema, field: string): void {
  const issues = validateSupportedJsonSchema(schema, field);
  if (issues.length === 0) return;
  throw new SkillRegistryError(
    "INVALID_MANIFEST",
    issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
  );
}

function parseBudget(value: Record<string, unknown>): SkillBudget {
  return {
    maxTurns: requirePositiveInteger(value.maxTurns, "budget.maxTurns"),
    maxToolCalls: requirePositiveInteger(value.maxToolCalls, "budget.maxToolCalls"),
    timeoutMs: requirePositiveInteger(value.timeoutMs, "budget.timeoutMs"),
    maxPromptBytes: requirePositiveInteger(value.maxPromptBytes, "budget.maxPromptBytes"),
    maxResultBytes: requirePositiveInteger(value.maxResultBytes, "budget.maxResultBytes"),
  };
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SkillRegistryError("INVALID_MANIFEST", `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertDescendant(root: string, candidate: string, message: string): void {
  const child = relative(root, candidate);
  if (!(child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))) return;
  throw new SkillRegistryError("PATH_ESCAPE", message);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillRegistryError("INVALID_MANIFEST", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new SkillRegistryError("INVALID_MANIFEST", `${field} must be a non-empty string`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SkillRegistryError("INVALID_MANIFEST", `${field} must be an array of strings`);
  }
  return [...new Set(value)];
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SkillRegistryError("INVALID_MANIFEST", `${field} must be a positive integer`);
  }
  return value;
}
