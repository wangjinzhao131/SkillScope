import type { JsonSchema } from "./contracts.js";

export interface SchemaIssue {
  path: string;
  message: string;
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "const",
  "enum",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
]);
const SUPPORTED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * Reject manifests that use validation keywords this small Runtime validator
 * cannot enforce. Accepting and silently ignoring those keywords would make a
 * Skill's declared input/output boundary weaker than its scope.json claims.
 */
export function validateSupportedJsonSchema(
  schema: JsonSchema,
  path = "$",
  issues: SchemaIssue[] = [],
): SchemaIssue[] {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) issues.push({ path: `${path}.${key}`, message: "uses an unsupported JSON Schema keyword" });
  }

  const type = schema.type;
  if (type !== undefined && (typeof type !== "string" || !SUPPORTED_TYPES.has(type))) {
    issues.push({ path: `${path}.type`, message: "must be one supported JSON Schema type" });
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    issues.push({ path: `${path}.enum`, message: "must be a non-empty array" });
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      issues.push({ path: `${path}.anyOf`, message: "must be a non-empty array of schemas" });
    } else {
      schema.anyOf.forEach((candidate, index) => {
        if (!isRecord(candidate)) issues.push({ path: `${path}.anyOf[${index}]`, message: "must be a schema object" });
        else validateSupportedJsonSchema(candidate, `${path}.anyOf[${index}]`, issues);
      });
    }
  }

  validateKeywordPlacement(schema, path, issues);
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) issues.push({ path: `${path}.properties`, message: "must be an object of schemas" });
    else for (const [name, candidate] of Object.entries(schema.properties)) {
      if (!isRecord(candidate)) issues.push({ path: `${path}.properties.${name}`, message: "must be a schema object" });
      else validateSupportedJsonSchema(candidate, `${path}.properties.${name}`, issues);
    }
  }
  if (schema.items !== undefined) {
    if (!isRecord(schema.items)) issues.push({ path: `${path}.items`, message: "must be one schema object; tuple schemas are unsupported" });
    else validateSupportedJsonSchema(schema.items, `${path}.items`, issues);
  }
  return issues;
}

/**
 * Small, dependency-free validator for the JSON Schema subset used by scoped
 * skill manifests. Pi/TypeBox performs the same validation at the tool gate;
 * this second check keeps the Runtime boundary testable without Pi installed.
 */
export function validateJsonSchema(schema: JsonSchema, value: unknown, path = "$", issues: SchemaIssue[] = []): SchemaIssue[] {
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
    return issues;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push({ path, message: `must be one of ${schema.enum.map(String).join(", ")}` });
    return issues;
  }

  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some((candidate) =>
      validateJsonSchema(asSchema(candidate), value, path, []).length === 0,
    );
    if (!valid) issues.push({ path, message: "must match at least one anyOf branch" });
  }

  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) {
      issues.push({ path, message: "must be an object" });
      return issues;
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) issues.push({ path: `${path}.${key}`, message: "is required" });
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateJsonSchema(asSchema(child), value[key], `${path}.${key}`, issues);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          issues.push({ path: `${path}.${key}`, message: "is not allowed" });
        }
      }
    }
    return issues;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path, message: "must be an array" });
      return issues;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    if (isRecord(schema.items)) value.forEach((item, index) => validateJsonSchema(schema.items as JsonSchema, item, `${path}[${index}]`, issues));
    return issues;
  }

  if (type === "string") {
    if (typeof value !== "string") issues.push({ path, message: "must be a string" });
    else {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push({ path, message: `must contain at least ${schema.minLength} characters` });
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) issues.push({ path, message: `must contain at most ${schema.maxLength} characters` });
    }
    return issues;
  }

  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
      issues.push({ path, message: `must be a${type === "integer" ? "n integer" : " number"}` });
    }
    return issues;
  }

  if (type === "boolean" && typeof value !== "boolean") issues.push({ path, message: "must be a boolean" });
  if (type === "null" && value !== null) issues.push({ path, message: "must be null" });
  return issues;
}

function asSchema(value: unknown): JsonSchema {
  return isRecord(value) ? value : {};
}

function validateKeywordPlacement(schema: JsonSchema, path: string, issues: SchemaIssue[]): void {
  const objectOnly = ["properties", "required", "additionalProperties"];
  const arrayOnly = ["items", "minItems", "maxItems"];
  const stringOnly = ["minLength", "maxLength"];
  for (const key of objectOnly) if (schema[key] !== undefined && schema.type !== "object") issues.push({ path: `${path}.${key}`, message: "requires type: object" });
  for (const key of arrayOnly) if (schema[key] !== undefined && schema.type !== "array") issues.push({ path: `${path}.${key}`, message: "requires type: array" });
  for (const key of stringOnly) if (schema[key] !== undefined && schema.type !== "string") issues.push({ path: `${path}.${key}`, message: "requires type: string" });

  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) {
    issues.push({ path: `${path}.required`, message: "must be an array of property names" });
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    issues.push({ path: `${path}.additionalProperties`, message: "only boolean additionalProperties is supported" });
  }
  for (const key of ["minItems", "maxItems", "minLength", "maxLength"]) {
    const value = schema[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
      issues.push({ path: `${path}.${key}`, message: "must be a non-negative integer" });
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
