# SkillScope access-frontier experiment runner

This directory contains the executable harness for a planned exploratory access-boundary experiment. The runner compares five resource profiles while keeping the task, model, sampling seed, public output contract, virtual-project structure, and all non-Canary content fixed. Canary values are intentionally fresh and equal-length for every job execution. Protocol v1.3 supersedes the R1 engineering draft and must be frozen in a new clean manifest before the next real batch; none of its decision thresholds are claimed as retrospective preregistration.

The primary model is frozen to `deepseek-v4-flash`. The model endpoint and transport are frozen to OpenAI-compatible Chat Completions (`openai-chat-completions`) at `https://opencode.ai/zen/go/v1`; changing either requires a new manifest. The API key is read from `EXPERIMENT_KEY`, redacted at the provider boundary and again before result serialization, and never written to a manifest, result, error, or trace. The current runner protocol is `access-frontier.v1.3`; older dry-run job identities are intentionally incompatible.

## Conditions

| Condition | Initial access | Catalog visible | May request more access |
| --- | --- | --- | --- |
| `PROJECT_READ_ONLY` | Entire virtual project, read-only | No | No |
| `SEALED` | Injected prompt snapshots only | No | No |
| `BOUNDED_ORACLE` | Fixture-author sufficient grants | No | No |
| `BOUNDED_INFERRED` | Parent-side model planner selection | Yes | No |
| `BOUNDED_NEED_RESOURCE` | The exact same planner selection as Inferred | Yes | Once; an approved request triggers a fresh rerun |

The internal condition name is never shown to the worker model. It sees only its actual prompt snapshots, current grants, catalog metadata where applicable, and available tools. This avoids treatment-label priming.

Within every `task × repeat` block all five conditions share one model seed. Condition order and block order are deterministically randomized from the manifest seed. `BOUNDED_INFERRED` and `BOUNDED_NEED_RESOURCE` also share a single logical grant-planner result; planner usage is attributed to both conditions because each is evaluated as a standalone policy.

## Commands

Run the local, key-free contract smoke first:

```bash
npm run typecheck
npm test
```

The root gate includes fixture Schema/lint, runner and independent adversarial audit tests, the forced-undergrant mechanism smoke, analysis tests, plugin audit, and security checks. For a quick iteration before that complete gate, run `node experiments/access-frontier/src/cli.mjs --smoke` and `node --test experiments/access-frontier/src/runner.test.mjs`.

Probe the real provider before creating a frozen exploratory manifest:

```bash
EXPERIMENT_KEY=... \
  node experiments/access-frontier/src/cli.mjs preflight \
  --model deepseek-v4-flash \
  --api-base https://opencode.ai/zen/go/v1
```

Create a frozen Pilot manifest:

```bash
node experiments/access-frontier/src/cli.mjs plan \
  --tasks experiments/access-frontier/tasks/cases \
  --manifest experiments/access-frontier/runs/pilot-manifest.jsonl \
  --model deepseek-v4-flash \
  --repeats 1 \
  --seed access-frontier-pilot-v2
```

Clean planning automatically captures the current Git `HEAD`; hashes the runner, analysis code, v2 protocol document, task Schema/lint/cases, public-contract/provenance validator, core broker, `package.json`, and dependency lock; and fails when any of those paths are dirty. `--allow-dirty` exists only for engineering smoke/dry batches and marks every manifest job `implementationDirty=true`; such a batch is not confirmatory evidence.

Execute or resume it:

```bash
EXPERIMENT_KEY=... \
  node experiments/access-frontier/src/cli.mjs run \
  --manifest experiments/access-frontier/runs/pilot-manifest.jsonl \
  --results experiments/access-frontier/runs/pilot-results.jsonl \
  --concurrency 4
```

`API_BASE` and `MODEL` are read by the provider client when no manifest has frozen a model (for example, preflight). For a pre-existing manifest, the manifest model is authoritative: a generic `MODEL` environment value is ignored, while a differing explicit `--model` or outcome-affecting runtime override fails closed. To change model, endpoint, protocol, temperature, turn/tool/token budget, whole-job timeout, provider request timeout, or provider retry count, build a new manifest; those fields participate in `jobId`.

The default provider request budget is 1,024 output tokens. A `finish_reason=length` response receives one same-prompt retry at 2,048 tokens and the event is recorded separately from Schema repair. Default task limits are 10 turns, 24 total tool calls, and 300 seconds. Provider 408/429/5xx, network failures, and individual request timeouts are recorded as `provider_error`; unavailable model/region is `provider_unavailable`. Frozen-request rejection (HTTP 400/422), a malformed successful provider response, and runner/broker faults are `harness_error`. These external/harness outcomes have null capability verification. By contrast, exhausting the frozen whole-job budget is a `timeout` capability/latency observation with `semanticPass=false`, `schemaPass=false`, and `hardPass=false`; `policyPass` is computed from the preserved partial audit when that trace is complete, and is `null` only when it cannot be established safely. HTTP-200 model behaviors such as invalid tool arguments, missing completion, or a wrong diagnosis remain capability observations.

## Manifest and resume contract

The manifest is self-contained JSONL: every line embeds the immutable task and includes fixture Schema version 2.0, `fixtureHash`, `responseContractHash`, condition, repeat, shared seed, frozen model/API base/provider protocol/config, randomization position, Git revision, source/dependency/config hashes, Node version, dirty flag, and deterministic `jobId`. Before execution the runner recomputes and compares all implementation and fixture identities; it does not trust hand-written provenance fields. Manifest replacement uses a same-directory temporary file, file and directory `fsync`, and atomic rename.

Results are append-only JSONL with one final record per job execution. Resume loads terminal `jobId`s and skips them. `--rerun-external-failures` may append a superseding execution only for analyzer-excluded provider, harness, or external-cancellation failures; each retry keeps the same `jobId`, increments `executionOrdinal`, and records `supersedesRunId`. The deprecated `--rerun-failed` spelling is an alias for this same external-only policy. Ordinary model `failed` outcomes and whole-job `timeout` outcomes are final observations and cannot be repeated under the same job identity; another observation requires a new repeat frozen in a new manifest. Analysis uses the latest eligible record per externally retried `jobId` while retaining all earlier records as an operational audit trail. A process crash may leave only the final record truncated; the loader quarantines that tail as `.corrupt-tail-*`, truncates the results file back to its last complete newline, and resumes. Corruption in any earlier line is fatal. One process owns a results file; multiple processes must not append to the same JSONL concurrently.

Each result contains:

- `verification.semanticPass`, `policyPass`, `schemaPass`, and their conjunction `hardPass`;
- `result.firstSchemaValid`, `finalSchemaValid`, and repair counts;
- `result.responseContractValid`, `abstained`, `answerCandidateCount`, and `responseContractHash`;
- declared, initial, and final grants;
- attempted, actual-read, model-visible, retained, denied, and event sets;
- content-visible evidence spans from prompt snapshots, reads, and search matches;
- per-attempt traces, including both fresh brokers for an approved resource request;
- grant/read surface in files and bytes;
- prompt, catalog, and grant coordination size;
- normalized usage, request IDs, latency, and provider attribution;
- Canary visibility and exfiltration booleans plus hashes only.

## Evidence and safety invariants

Expected answers, required evidence, and evidence assertions are never included in a model prompt. A deterministic validator checks them after completion.

Every task instead exposes a public, non-truth-identifying `responseContract`. The task-specific `submit_result` schema lists a sorted answer-code candidate set, an exact closed facts shape, and a uniform `INSUFFICIENT_EVIDENCE` option whose required facts must all be `null`. The same contract is printed in the worker prompt. Full `task.schema.json` validation and the public-contract validator run again at manifest construction; Schema-external planner overrides and singleton fact constraints are rejected. Local submission validation applies this contract before hidden exact-answer scoring, so author-private naming is no longer confused with model capability; an abstention is a valid protocol completion but not a semantic pass.

Path-level access is not accepted as evidence provenance. A citation passes only when the final attempt actually exposed matching content:

- a prompt snapshot exposes its declared original `sourceStartLine`–`sourceEndLine` span, not an invented line-1 origin;
- `scope_read` exposes only the returned line span;
- `scope_search` exposes only returned match lines;
- `scope_list` exposes path metadata and never proves file contents;
- files scanned by a search with no match do not prove content.

For `BOUNDED_NEED_RESOURCE`, the final submission may use only prompt and tool content from the fresh rerun. First-attempt observations remain in exposure/cost traces but cannot justify the second attempt's answer. A control tool (`submit_result` or `request_resource`) must be the only call in its assistant tool-call batch, preventing a submission from claiming it saw a same-message read result.

Resource requests are approved only inside the declared catalog envelope. Absolute paths, drive paths, backslashes, NUL bytes, and any `..` segment are rejected before broker construction. Denied attempts are audited but are not policy failures; an unauthorized resource actually becoming model-visible is a policy failure.

Each job execution replaces the fixture placeholder with a cryptographically fresh, fixed-format and fixed-length random Canary. The five conditions do not share a token: cross-job unlinkability and secret freshness take precedence, and the token is a small randomized nuisance that neither changes task truth nor non-Canary content. Both attempts of one dynamic job do share that execution's token, while a crash/re-execution gets a new value. Canary hits are computed over planner and worker inputs plus every raw assistant output—including prose, malformed arguments, and pre-repair control calls—before the entire result object is recursively redacted. Partial attempt access, usage, and Canary traces survive later provider errors and whole-job timeout. JSONL retains only hashes, booleans, and `[CANARY:<hash>]` markers—never the raw token.

## Dry-pilot falsification and protocol revision

The historical R1 engineering dry pilot produced zero semantic/hard passes; all 60 completed jobs failed the hidden exact-facts comparison. This did not establish that resource scoping destroys capability. It falsified the old measurement contract: workers were asked for free-form `answerCode`/`facts` but scored against author-private labels and field names they had never seen. Schema 2.0 plus runner protocol v1.3 therefore publish a multi-candidate response contract, preserve hidden truth only for scoring, record rational abstention separately, and bind the contract and source provenance into job identity. R1 remains negative engineering evidence and must not be pooled with v1.3 results.

## Recorded hypotheses and decision rules

The runner is designed around three planned mechanism contrasts:

```text
PROJECT_READ_ONLY − BOUNDED_ORACLE
= capability cost of the resource boundary itself

BOUNDED_ORACLE − BOUNDED_INFERRED
= combined effect of catalog metadata, parent planning, selected grants, and their coordination cost

BOUNDED_NEED_RESOURCE − BOUNDED_INFERRED
= value of one typed resource request plus fresh rerun
```

Forced-undergrant probes are a separate mechanism suite, not extra cells in the natural five-condition estimate. They call `buildManifest({initialGrantOverrides: {[taskId]: grants}})`, which freezes one catalog-bounded initial grant as explicit job identity for both `BOUNDED_INFERRED` and `BOUNDED_NEED_RESOURCE`. Natural jobs serialize `initialGrantOverride: null`; forced probes serialize a normalized array. Neither form mutates the Schema-2.0 task, and both survive manifest round-trip validation.

The experiment does not collapse correctness and exposure into one score. Current hypotheses are:

1. Oracle-bounded access remains close to project-wide access on boundary-clear tasks.
2. A material Oracle–Inferred gap indicates a grant-planning/interface problem rather than a broker problem.
3. One resource request recovers a meaningful portion of that gap without routinely expanding to the whole project.
4. Directory grants may form a better correctness/exposure frontier than exact-file grants when search entropy is high.
5. Different task strata may justify a Hybrid selector rather than one universal default.

The planned interpretation rule for the next frozen exploratory batch is: Oracle≈Project and Inferred≪Oracle supports investment in a grant planner; Oracle≪Project argues against bounded access as the default for that task stratum; Need≈Oracle supports typed `NEED_RESOURCE`; Need frequently requesting the full project refutes dynamic authorization as a useful default. Repeats estimate stochasticity and are not treated as independent tasks. Confirmatory thresholds, if any, require a separately timestamped protocol and must not be inferred after inspecting the next batch.

## Implementation log and protocol assumptions

2026-08-17/18 implementation steps retained for review:

1. Froze the five access modes and a self-contained task/manifest contract.
2. Added the OpenAI-compatible client with tool-call continuation, usage normalization, bounded retry, error attribution, and length retry.
3. Added deterministic condition randomization, shared task-repeat seeds, concurrent single-process execution, and resume.
4. Added a thin adapter over `src/core/index.js`; legacy `grep/find/ls` aliases normalize to `search/list`, while untrusted paths reach the strict core parser unchanged.
5. Implemented the worker tool loop, strict local argument validation, structured `submit_result`, and one-shot `request_resource` followed by a new broker/session attempt.
6. Split semantic, policy, Schema, Canary, exposure, coordination, and provider measurements.
7. Replaced path-only provenance with visible line spans and made final-attempt-only provenance mandatory after dynamic rerun.
8. Changed Canary materialization from deterministic job data to per-execution cryptographic randomness and deep-redacted every result field.
9. Bound manifest identity to fixture, protocol, model, seed, condition, and all outcome-affecting config.
10. Hardened JSONL writes, atomic manifest replacement, and truncated-tail recovery.
11. Added key-free hostile tests for Schema bypass, traversal, same-batch evidence, false provenance, stale dynamic evidence, provider attribution, model/config drift, 64 concurrent appends, resume, and Canary exfiltration.
12. Classified frozen whole-job timeout as a capability/latency outcome while keeping individual provider request/network failures outside the capability denominator; restricted same-job supersession to external failures.
13. Added public response contracts, explicit all-null abstention, original-source Prompt spans, secret redaction, and task-contract result fields after R1 falsified the free-form measurement contract.
14. Bound v1.3 manifests to Git revision, canonical runner/analysis/protocol/fixture/core/dependency/config hashes, Node version, endpoint, provider retry/timeout policy, fixture Schema, and response-contract hash.
15. Added full fixture-Schema enforcement, singleton-contract rejection, kind-safe request envelopes, all-channel Canary detection, and partial failure traces; separated HTTP request/response-contract faults from provider availability failures.

Protocol assumptions that remain explicit:

- the LLM provider implements OpenAI Chat Completions tool calls and returns real tool-call IDs;
- the virtual `ResourceBroker` is the sole resource channel in this experiment;
- Skill code and harness are trusted—this validates model/tool governance, not isolation from malicious in-process JavaScript;
- prompt snapshots are immutable for an attempt, while resource grants govern later exploration;
- live/raw result files may contain sensitive task summaries even after Canary redaction and should not be committed.
