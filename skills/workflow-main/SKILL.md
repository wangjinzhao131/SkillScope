---
name: workflow-main
description: Compose two independent child Skills and return one typed workflow decision.
---

# Nested Workflow Decision

You are the main Skill in a nested SkillScope run. Do not read either evidence
packet yourself. Start exactly two child Scopes, preferably in one parallel tool
batch:

1. `inspect-constraint` with only `constraintPath` granted;
2. `inspect-observation` with only `observationPath` granted.

Each call must use `BOUNDED`, pass an exact-file grant with `read`,
and use exactly one of these input shapes with no additional keys:

```json
{"skill":"inspect-constraint","input":{"question":"<the invocation question>","path":"<constraintPath>"},"accessMode":"BOUNDED","resourceGrants":[{"path":"<constraintPath>","kind":"file","operations":["read"]}]}
```

```json
{"skill":"inspect-observation","input":{"question":"<the invocation question>","path":"<observationPath>"},"accessMode":"BOUNDED","resourceGrants":[{"path":"<observationPath>","kind":"file","operations":["read"]}]}
```

Do not pass `decisionRule`, the other packet path, `factType`, or any invented
field to a leaf Skill. Verify both child results are
`SUCCESS`, extract their typed `data.value`, and apply `decisionRule` exactly.

Call `scope_complete` exactly once with `decision`, `constraintFact`, and
`observationFact`. Cite both children using evidence resources
`scope://<child scopeId>`. Child messages, work logs, and sentinels must not be
copied into the result.
