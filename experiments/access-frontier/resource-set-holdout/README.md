# ResourceSet repository-snapshot experiment

This suite evaluates one experimental navigation primitive: `scope_search_set` searches across a frozen set of exact-file search grants without authorizing the parent directory. It is wired into the access-frontier harness only; the Pi plugin v0.1 and its public SkillSpec do not yet expose ResourceSets.

The suite snapshots 24 committed files from this repository and freezes six two-source maintenance questions. Four paired cells compare author-known Oracle files, 24 exact files without aggregation, the same exact files with one ResourceSet handle, and a directory-root search handle. See [ResourceSet真实仓库快照实验预注册 v1](../../../docs/research/ResourceSet真实仓库快照实验预注册_v1.md) for estimands and limits.

Local gates and scripted smoke do not call a provider:

```bash
node --test experiments/access-frontier/resource-set-holdout/*.test.mjs
node experiments/access-frontier/resource-set-holdout/executor.mjs --smoke
```

After the design is committed and the tree is clean:

```bash
node experiments/access-frontier/resource-set-holdout/executor.mjs plan
EXPERIMENT_KEY=... node experiments/access-frontier/resource-set-holdout/executor.mjs run \
  --concurrency-per-cell 1
```

Raw descriptor/manifests/results live under the ignored `runs/` directory. Commit only reviewed aggregate reports and their file hashes.
