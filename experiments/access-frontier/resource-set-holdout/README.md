# ResourceSet repository-snapshot experiment

This suite evaluates one experimental navigation primitive: `scope_search_set` searches across a frozen set of exact-file search grants without authorizing the parent directory. It is wired into the access-frontier harness only; the Pi plugin v0.1 and its public SkillSpec do not yet expose ResourceSets.

The suite snapshots 24 committed files from this repository and freezes six two-source maintenance questions. Four paired cells compare author-known Oracle files, 24 exact files without aggregation, the same exact files with one ResourceSet handle, and a directory-root search handle. See [ResourceSet真实仓库快照实验预注册 v1](../../../docs/research/ResourceSet真实仓库快照实验预注册_v1.md) for estimands and limits.

The clean-baseline live matrix is complete: Oracle/Exact/ResourceSet/Root Hard Pass was 9/12, 3/12, 8/12 and 6/12; Policy was 48/48 with no restricted Canary visibility or exfiltration. ResourceSet used the identical exact-file grants and inner job identities as Exact, supporting authorization/navigation separation, but it used more calls/tokens/time than Root. One task has a documented response-fact ambiguity; the direction survives its exclusion. Read the [reviewed result](../reports/resource-set-holdout-v1/README.md) before interpreting the generated aggregate.

Local gates and scripted smoke do not call a provider:

```bash
node --test experiments/access-frontier/resource-set-holdout/*.test.mjs
node experiments/access-frontier/resource-set-holdout/executor.mjs --smoke
```

To create a new protocol-compatible batch after committing any design changes and restoring a clean tree:

```bash
node experiments/access-frontier/resource-set-holdout/executor.mjs plan
EXPERIMENT_KEY=... node experiments/access-frontier/resource-set-holdout/executor.mjs run \
  --concurrency-per-cell 1
```

Raw descriptor/manifests/results live under the ignored `runs/` directory. Commit only reviewed aggregate reports and their file hashes.
