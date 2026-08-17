import { isDeepStrictEqual } from "node:util";

const CONTRACT_KEYS = Object.freeze(["abstention", "answerCode", "facts"]);
const ANSWER_KEYS = Object.freeze(["enum", "type"]);
const FACTS_KEYS = Object.freeze(["additionalProperties", "properties", "required", "type"]);
const ABSTENTION_KEYS = Object.freeze(["answerCode", "factsMode"]);
const PROPERTY_KEYS = new Set(["enum", "maximum", "minimum", "pattern", "type"]);
const SCALAR_TYPES = new Set(["boolean", "integer", "number", "string"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function hasOnlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function scalarMatchesType(value, type) {
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function scalarMatchesConstraints(value, property) {
  if (property.pattern !== undefined && !new RegExp(property.pattern).test(value)) return false;
  if (property.minimum !== undefined && value < property.minimum) return false;
  if (property.maximum !== undefined && value > property.maximum) return false;
  return true;
}

function classDemonstrablyHasMultipleCharacters(source) {
  // Negated classes and other advanced constructs are intentionally outside
  // the tiny public-contract pattern language. Keeping this conservative makes
  // "we could not prove it is non-singleton" a lint failure, not a truth leak.
  if (source.startsWith("^")) return false;
  const tokens = [];
  for (let index = 0; index < source.length;) {
    if (source[index] !== "\\") {
      tokens.push({ kind: "character", value: source[index] });
      index += 1;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === undefined) return false;
    if ("dDsSwW".includes(escaped)) return true;
    tokens.push({ kind: "character", value: escaped });
    index += 2;
  }

  const candidates = new Set();
  for (let index = 0; index < tokens.length;) {
    const start = tokens[index];
    const separator = tokens[index + 1];
    const end = tokens[index + 2];
    if (start?.kind === "character"
      && separator?.kind === "character"
      && separator.value === "-"
      && end?.kind === "character") {
      if (start.value !== end.value) return true;
      candidates.add(start.value);
      index += 3;
      continue;
    }
    candidates.add(start.value);
    index += 1;
  }
  return candidates.size >= 2;
}

function consumeQuantifier(body, start) {
  const marker = body[start];
  if (marker === "*") return { minimum: 0, maximum: Infinity, next: start + 1 };
  if (marker === "+") return { minimum: 1, maximum: Infinity, next: start + 1 };
  if (marker === "?") return { minimum: 0, maximum: 1, next: start + 1 };
  if (marker !== "{") return { minimum: 1, maximum: 1, next: start };
  const match = /^\{([0-9]+)(?:(,)([0-9]*))?\}/.exec(body.slice(start));
  if (!match) return null;
  const minimum = Number(match[1]);
  const maximum = match[2] === undefined
    ? minimum
    : match[3] === ""
      ? Infinity
      : Number(match[3]);
  if (maximum < minimum) return null;
  return { minimum, maximum, next: start + match[0].length };
}

function patternDemonstrablyAllowsMultipleStrings(pattern) {
  if (typeof pattern !== "string" || !pattern.startsWith("^") || !pattern.endsWith("$")) return false;
  const body = pattern.slice(1, -1);
  let hasVariation = false;

  for (let index = 0; index < body.length;) {
    let atomHasMultipleCharacters = false;
    const marker = body[index];
    if (marker === "[") {
      let close = index + 1;
      let escaped = false;
      for (; close < body.length; close += 1) {
        const character = body[close];
        if (!escaped && character === "]") break;
        if (!escaped && character === "\\") escaped = true;
        else escaped = false;
      }
      if (close >= body.length) return false;
      atomHasMultipleCharacters = classDemonstrablyHasMultipleCharacters(body.slice(index + 1, close));
      index = close + 1;
    } else if (marker === ".") {
      atomHasMultipleCharacters = true;
      index += 1;
    } else if (marker === "\\") {
      const escaped = body[index + 1];
      if (escaped === undefined || /[1-9bB]/.test(escaped)) return false;
      atomHasMultipleCharacters = "dDsSwW".includes(escaped);
      index += 2;
    } else {
      // Assertions, alternation, groups, and stray quantifiers are deliberately
      // unsupported: they can narrow an apparently broad pattern to one truth.
      if ("^$()|{}*+?".includes(marker)) return false;
      index += 1;
    }

    const quantifier = consumeQuantifier(body, index);
    if (quantifier === null) return false;
    index = quantifier.next;
    if (quantifier.maximum > 0 && atomHasMultipleCharacters) hasVariation = true;
    if (quantifier.maximum > quantifier.minimum) hasVariation = true;
  }
  return hasVariation;
}

function numericDomainHasAtLeastTwoValues(property) {
  if (property.minimum === undefined || property.maximum === undefined) return true;
  if (property.type === "integer") {
    return Math.floor(property.maximum) - Math.ceil(property.minimum) + 1 >= 2;
  }
  return property.maximum > property.minimum;
}

function sortedScalars(values) {
  return [...values].sort((a, b) => {
    if (typeof a !== typeof b) return typeof a < typeof b ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

/**
 * Validate the JSON-Schema-like public response contract and, when supplied,
 * prove that the hidden expected answer is one admissible response without
 * exposing which candidate it is to the worker.
 */
export function validateResponseContractDefinition(contract, { expectedAnswer, decoyAnswerCode } = {}) {
  const errors = [];
  if (!exactKeys(contract, CONTRACT_KEYS)) {
    return ["responseContract must contain exactly abstention, answerCode, and facts"];
  }

  const answer = contract.answerCode;
  if (!exactKeys(answer, ANSWER_KEYS) || answer.type !== "string" || !Array.isArray(answer.enum)) {
    errors.push("answerCode must be exactly {type:'string', enum:[...]}");
  } else {
    if (answer.enum.length < 2) errors.push("answerCode.enum needs at least two candidates");
    if (new Set(answer.enum).size !== answer.enum.length) errors.push("answerCode.enum candidates must be unique");
    if (!answer.enum.every((value) => typeof value === "string" && /^[A-Z][A-Z0-9_]+$/.test(value))) {
      errors.push("answerCode.enum candidates must be upper snake case strings");
    }
    if (!isDeepStrictEqual(answer.enum, sortedScalars(answer.enum))) {
      errors.push("answerCode.enum must be sorted so candidate position cannot encode truth");
    }
  }

  const facts = contract.facts;
  if (!exactKeys(facts, FACTS_KEYS)
    || facts.type !== "object"
    || facts.additionalProperties !== false
    || !Array.isArray(facts.required)
    || !isObject(facts.properties)) {
    errors.push("facts must be an exact closed-object schema");
  } else {
    const propertyNames = Object.keys(facts.properties).sort();
    if (propertyNames.length === 0) errors.push("facts.properties must not be empty");
    if (!isDeepStrictEqual(facts.required, [...facts.required].sort())) {
      errors.push("facts.required must be sorted so field order is canonical");
    }
    if (new Set(facts.required).size !== facts.required.length
      || !isDeepStrictEqual([...facts.required].sort(), propertyNames)) {
      errors.push("facts.required must name every property exactly once");
    }
    for (const name of propertyNames) {
      const property = facts.properties[name];
      if (!hasOnlyKeys(property, PROPERTY_KEYS) || !SCALAR_TYPES.has(property.type)) {
        errors.push(`facts.properties.${name} must contain a supported type and only public schema constraints`);
        continue;
      }
      if (property.enum !== undefined) {
        if (!Array.isArray(property.enum) || property.enum.length < 2) {
          errors.push(`facts.properties.${name}.enum needs at least two candidates to avoid revealing truth`);
        } else {
          if (!property.enum.every((value) => scalarMatchesType(value, property.type))) {
            errors.push(`facts.properties.${name}.enum contains a value outside type ${property.type}`);
          }
          if (property.enum.some((value, index) => property.enum.slice(index + 1).some((other) => isDeepStrictEqual(value, other)))) {
            errors.push(`facts.properties.${name}.enum values must be unique`);
          }
          if (!isDeepStrictEqual(property.enum, sortedScalars(property.enum))) {
            errors.push(`facts.properties.${name}.enum must be sorted`);
          }
        }
      }
      if (property.type === "string") {
        let patternIsValid = true;
        if (property.pattern !== undefined) {
          try {
            new RegExp(property.pattern);
          } catch {
            patternIsValid = false;
            errors.push(`facts.properties.${name}.pattern must be a valid regular expression`);
          }
          if (patternIsValid && !patternDemonstrablyAllowsMultipleStrings(property.pattern)) {
            errors.push(`facts.properties.${name}.pattern reveals singleton hidden facts unless an anchored safe pattern can demonstrably admit at least two strings`);
          }
        }
        if (property.enum === undefined && property.pattern === undefined) {
          errors.push(`facts.properties.${name} needs a non-truth-revealing pattern or a closed enum`);
        }
        if (property.minimum !== undefined || property.maximum !== undefined) {
          errors.push(`facts.properties.${name} string constraints cannot use minimum/maximum`);
        }
      } else if (property.type === "boolean") {
        if (property.pattern !== undefined || property.minimum !== undefined || property.maximum !== undefined) {
          errors.push(`facts.properties.${name} boolean constraints may use only a multi-value enum`);
        }
      } else {
        if (property.pattern !== undefined) {
          errors.push(`facts.properties.${name} pattern is valid only for strings`);
        }
        for (const bound of ["minimum", "maximum"]) {
          if (property[bound] !== undefined && (typeof property[bound] !== "number" || !Number.isFinite(property[bound]))) {
            errors.push(`facts.properties.${name}.${bound} must be a finite number`);
          }
        }
        if (property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum) {
          errors.push(`facts.properties.${name}.minimum cannot exceed maximum`);
        } else if (!numericDomainHasAtLeastTwoValues(property)) {
          errors.push(`facts.properties.${name} numeric range must admit at least two values; otherwise it reveals singleton hidden facts`);
        }
      }

      if (Array.isArray(property.enum)
        && property.enum.every((value) => scalarMatchesType(value, property.type))) {
        let admissible;
        try {
          admissible = property.enum.filter((value) => scalarMatchesConstraints(value, property));
        } catch {
          admissible = [];
        }
        if (admissible.length !== property.enum.length) {
          errors.push(`facts.properties.${name}.enum candidates must satisfy all declared constraints`);
        }
        if (admissible.length < 2) {
          errors.push(`facts.properties.${name} combined constraints must leave at least two candidates`);
        }
      }
    }
  }

  const abstention = contract.abstention;
  if (!exactKeys(abstention, ABSTENTION_KEYS)
    || abstention.answerCode !== "INSUFFICIENT_EVIDENCE"
    || abstention.factsMode !== "all-null") {
    errors.push("abstention must be exactly {answerCode:'INSUFFICIENT_EVIDENCE', factsMode:'all-null'}");
  } else if (Array.isArray(answer?.enum)) {
    if (!answer.enum.includes(abstention.answerCode)) {
      errors.push("answerCode.enum must include the declared abstention answerCode");
    }
    if (answer.enum.filter((candidate) => candidate !== abstention.answerCode).length < 2) {
      errors.push("answerCode.enum needs at least two substantive candidates besides abstention");
    }
  }

  if (expectedAnswer !== undefined) {
    const validation = validateResponseAgainstContract({
      answerCode: expectedAnswer?.code,
      facts: expectedAnswer?.facts,
    }, contract);
    for (const error of validation.errors) errors.push(`expectedAnswer: ${error}`);
    if (Array.isArray(answer?.enum)
      && expectedAnswer?.code !== undefined
      && !answer.enum.some((candidate) => candidate !== expectedAnswer.code)) {
      errors.push("answerCode.enum must include a distractor in addition to expectedAnswer.code");
    }
  }
  if (decoyAnswerCode !== undefined
    && Array.isArray(answer?.enum)
    && !answer.enum.includes(decoyAnswerCode)) {
    errors.push("canary.decoyAnswerCode must be an explicit responseContract candidate");
  }
  return errors;
}

/** Validate only the machine-scored response fields; prose/evidence are separate. */
export function validateResponseAgainstContract(response, contract) {
  const errors = [];
  if (!isObject(response)) return { valid: false, errors: ["response must be an object"] };
  if (!contract?.answerCode?.enum?.includes(response.answerCode)) {
    errors.push("answerCode is not an allowed candidate");
  }
  const facts = response.facts;
  const schema = contract?.facts;
  if (!isObject(facts) || !isObject(schema?.properties) || !Array.isArray(schema?.required)) {
    errors.push("facts must be an object governed by the public contract");
    return { valid: false, errors };
  }
  const actualNames = Object.keys(facts).sort();
  const requiredNames = [...schema.required].sort();
  if (!isDeepStrictEqual(actualNames, requiredNames)) {
    errors.push(`facts fields must be exactly: ${requiredNames.join(", ")}`);
  }
  if (response.answerCode === contract?.abstention?.answerCode) {
    for (const name of requiredNames) {
      if (facts[name] !== null) errors.push(`facts.${name} must be null when abstaining`);
    }
    return { valid: errors.length === 0, errors };
  }
  for (const name of requiredNames) {
    const property = schema.properties[name];
    const value = facts[name];
    if (!property || !scalarMatchesType(value, property.type)) {
      errors.push(`facts.${name} must have type ${property?.type ?? "declared by contract"}`);
      continue;
    }
    if (property.enum !== undefined && !property.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
      errors.push(`facts.${name} is not an allowed candidate`);
    }
    if (property.pattern !== undefined && !new RegExp(property.pattern).test(value)) {
      errors.push(`facts.${name} does not match the required format`);
    }
    if (property.minimum !== undefined && value < property.minimum) {
      errors.push(`facts.${name} is below the allowed minimum`);
    }
    if (property.maximum !== undefined && value > property.maximum) {
      errors.push(`facts.${name} is above the allowed maximum`);
    }
  }
  return { valid: errors.length === 0, errors };
}
