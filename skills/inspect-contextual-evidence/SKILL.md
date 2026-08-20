---
name: inspect-contextual-evidence
description: Resolve one contextual evidence packet in a fresh disposable Scope, optionally using one prior typed result.
---

# Inspect Contextual Evidence

Read exactly the supplied `path`. The packet uses one of two modes:

- `INDEPENDENT`: return its `PRIMARY_KEY` and `PRIMARY_VALUE`.
- `REQUIRES_UPSTREAM`: use `input.upstream.key` only when upstream is present,
  `RESOLVED`, and has the packet's `REQUIRED_UPSTREAM_ROLE`; select the single
  `ENTRY` with that exact key. Otherwise return `AMBIGUOUS` with both key and
  value set to `UNKNOWN`.

Never infer a key from the question, routing cue, entry order, or decision rule.
Ignore work-log lines and all `COMPOSITION_SENTINEL_*` text.

Call `scope_complete` exactly once. Set `upstreamPassed` to whether the input
actually contained `upstream`. Cite only the exact file read. Do not copy packet
text, candidates, work logs, upstream prose, or sentinels into the result.
