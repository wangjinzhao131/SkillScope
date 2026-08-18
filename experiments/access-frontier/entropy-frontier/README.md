# High-search-entropy experiment

This suite follows the Schema 2 Pilot's only failed family. It creates five semantically distinct two-hop investigations with 16 opaque shards and compares a file Oracle, all-shard access at two tool budgets, one recursive root search handle, and the model grant planner. The frozen design and interpretation rules are in [高搜索熵访问实验预注册 v1](../../../docs/research/高搜索熵访问实验预注册_v1.md).

The experiment is diagnostic. It does not estimate production safety, natural dynamic-resource value, or SkillScope's total effect against an ordinary Subagent.

Local gate:

```bash
node --test experiments/access-frontier/entropy-frontier/executor.test.mjs
```

From a clean pre-data commit, freeze all five cell manifests before the first task call:

```bash
node experiments/access-frontier/entropy-frontier/executor.mjs plan \
  --run-id entropy-frontier-v1-pilot \
  --repeats 2 \
  --seed skillscope-entropy-frontier-v1 \
  --model deepseek-v4-flash
```

Then run all cells concurrently with one writer/worker per cell. Raw descriptor, manifests, and results stay under the ignored `runs/` directory:

```bash
EXPERIMENT_KEY=... \
  node experiments/access-frontier/entropy-frontier/executor.mjs run \
  --run-id entropy-frontier-v1-pilot \
  --concurrency-per-cell 1 \
  --summary experiments/access-frontier/reports/entropy-frontier-v1-summary.jsonl \
  --report experiments/access-frontier/reports/entropy-frontier-v1-report.md
```

`summarize` is offline and may be rerun against the frozen raw files. Generated summaries remain exploratory until their raw job/identity alignment and task-level failures are manually audited.

The post-Pilot [planner output-budget probe](../../../docs/research/Planner输出预算实验预注册_v1.md) is a separate 60-trial mechanism experiment. It calls only the parent planner and crosses root/sharded catalog width with 512/1024/2048 output-token limits:

```bash
node experiments/access-frontier/entropy-frontier/planner-budget-probe.mjs plan
EXPERIMENT_KEY=... node experiments/access-frontier/entropy-frontier/planner-budget-probe.mjs run
```

The completed result is reviewed in [planner-budget-v1/README.md](../reports/planner-budget-v1/README.md): root catalogs were valid 30/30, while sharded catalogs improved from 0/10 at 512 to 9/10 at 2048; all valid sharded plans selected all 16 entries, so protocol recovery did not create selectivity.
