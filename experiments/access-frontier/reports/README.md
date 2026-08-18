# Generated access-frontier reports

Reviewed experiment narratives are kept beside generated machine summaries. The completed high-search-entropy diagnostic is documented in [entropy-frontier-v1/README.md](./entropy-frontier-v1/README.md); its `*-amended-*` files correct reporting denominators without changing frozen raw outcomes. The subsequent planner-only mechanism result is in [planner-budget-v1/README.md](./planner-budget-v1/README.md).

This directory is reserved for reproducible outputs from `experiments/access-frontier/analysis/analyze.py`. Raw JSONL belongs in `experiments/access-frontier/runs/`; do not place credentials, provider request headers, or unredacted model traces here.

A report directory contains:

- `report.md` — separate semantic/policy/Hard Pass, public-contract-validity, and rational-abstention summaries; answer-candidate `K` and descriptive `1/K`; family-cluster paired differences with task sensitivity; exposure/leak/exfiltration channels; `NEED_RESOURCE` recovery; evidence-to-design mappings; data-quality coverage; and exploratory limits;
- `normalized_runs.csv` — the analyzer's canonical per-run view;
- `condition_summary.csv` — descriptive condition metrics with measured denominators;
- `paired_differences.csv` — fixed-seed paired family-cluster primary estimates and task-cluster sensitivity intervals;
- `need_resource_recovery.csv` — typed-request rescue, regression, approval, and incremental-cost diagnostics.

For the natural matrix, `need_resource_recovery.csv` reports `recovery_status=NOT_IDENTIFIABLE` and leaves recovery rates/fractions blank when no measured `BOUNDED_NEED_RESOURCE` run actually requested a resource. Raw opportunity and fail→pass transition fields remain for intention-to-treat condition-package diagnosis; they are not request-mediated recovery estimates. The Markdown design mapping is likewise blocked from treating a zero-activation Dynamic↔Inferred contrast as evidence for or against the request mechanism.

Generate a report from the repository root:

```bash
python3 experiments/access-frontier/analysis/analyze.py \
  --input experiments/access-frontier/runs/results.jsonl \
  --manifest experiments/access-frontier/runs/manifest.jsonl \
  --output-dir experiments/access-frontier/reports/latest
```

If `manifest.jsonl` is beside the result input, the analyzer auto-discovers it. Planned-coverage diagnostics require that frozen plan so tasks with no result in either contrast arm remain in the denominator. Append-only provider/harness/external-cancellation reruns sharing a `jobId` are reduced to the last JSONL record, while superseded records remain visible in the normalized audit CSV and exclusion table. Superseding an ordinary capability failure or `JOB_TIMEOUT` is rejected as unfrozen optional stopping; allocate a new repeat or preregister an internal retry rule instead.

Reports are exploratory until the task corpus, runner, model configuration, randomization, hypotheses, exclusions, and decision thresholds have been frozen before a repository- and template-separated holdout. In particular, zero observed Canary hits is not evidence of zero leakage when Canary instrumentation is missing or attack opportunities are too few. Project-wide Canary visibility is reported as exposure, while visibility in SEALED/BOUNDED modes is a boundary failure; neither is silently folded into semantic correctness.

Capability summaries exclude provider/harness/external interruptions, but the safety audit does not: every append-log row, including superseded executions, is scanned for scoped Canary visibility, result/exfiltration hits, and deterministic `policyViolations`. Any such retained event remains a stop signal even when the enclosing run is excluded from the capability denominator.

All current protocol batches are engineering/exploratory diagnostics even when they have a manifest. v1.3 identity-binds its analyzer, implementation, preregistration source, embedded corpus, public response contract, fixture Schema, provider budgets, natural/forced initial-grant suite, and ordered manifest. Its preregistration nevertheless defines only an exploratory seven-family pilot, without a confirmatory mapping margin, power target, or sealed holdout decision. The analyzer therefore keeps its trusted mapping-protocol set empty; a future confirmatory protocol must freeze those statistical decisions before any automated architecture-mapping gate can open.

The three differences are mechanism-package contrasts rather than pure algorithm effects. Natural matrix jobs have `initialGrantOverride: null`; forced-undergrant suites have an array. Dynamic↔Inferred effects in a forced suite describe rescue under engineered missing-evidence opportunities and must not be reported as the natural request rate or default-workload benefit. `1/K` is only a uniform answer-code guessing reference; facts and evidence prevent treating it as a semantic or Hard-Pass chance baseline.

The 14-task corpus represents only seven counterfactual `pairId` families; family-cluster uncertainty is primary and task-cluster uncertainty is sensitivity-only. H4 has one family, while H5/H6 lack a treatment contrast, so those hypotheses cannot be promoted into causal or product conclusions.

`r1` is a completed 70/70-job engineering dry pilot, but its invalid measurement/output contract makes the report non-formal. The current +5 percentage-point mapping margin is a post-hoc exploratory aid, not a preregistered threshold; freeze a confirmatory margin in the next protocol before opening its holdout.

Provider/harness failures and external/user `CANCELLED` interruptions are retained and counted but excluded from capability denominators. `JOB_TIMEOUT` remains a capability/latency failure relative to the frozen per-job time budget, so reports should disclose that budget when interpreting timeout rates.

## Amending a completed report

Do not overwrite `schema2-pilot-v1/`: it is the immutable report produced from the completed live v1.3 batch with the then-frozen analyzer state. Its natural `NEED_RESOURCE` recovery `0%` label is a known analysis error, not a result to interpret; retaining it unchanged preserves the audit trail. A later analyzer correction must use a new directory whose name says `amended`, for example:

```bash
python3 experiments/access-frontier/analysis/analyze.py \
  --input experiments/access-frontier/runs/schema2-pilot-v1-results.jsonl \
  --manifest experiments/access-frontier/runs/schema2-pilot-v1-manifest.jsonl \
  --output-dir experiments/access-frontier/reports/schema2-pilot-v1-amended-20260818 \
  --seed 20260818 \
  --bootstrap-replicates 5000
```

Label that directory/report as a post-freeze analyzer amendment. It reuses and validates the frozen experimental manifest and raw results, but the changed analyzer code is not retroactively the analyzer identity frozen by that manifest. Keep the original and amended artifacts side by side so the correction is auditable.
