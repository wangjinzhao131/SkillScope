# Forced-undergrant 机制实验

本目录定义一个与自然五臂矩阵分离的机制实验。R1 dry pilot 中 `BOUNDED_NEED_RESOURCE` 的自然 request 触发率是 0/14，因此不能从该批估计动态补权的恢复效果；把这一零触发率解释成“补权无效”同样错误。

`forced-undergrant.v1.json` 为两个任务固定同一份、确定缺少至少一个必要证据的初始 grant，并配对比较：

- `FORCED_UNDERGRANT_NO_EXPANSION`：禁止请求补权；
- `FORCED_UNDERGRANT_NEED_RESOURCE`：允许一次 catalog-bounded typed request，批准后必须 fresh rerun，第一次尝试的模型消息不能续接到第二次。

两个 arm 除 `allowResourceRequest` 与批准后的 fresh-rerun 能力外必须相同：task、seed、初始 grant、Prompt、response contract、模型与预算全部配对。主要机制 estimand 是在“已知初始 grant 不充分”这一条件下，开放一次补权所造成的 `semanticPass` 配对恢复差；次要结果包括有效请求率、批准率、恢复率、额外协调 token 和授权面积。

该 suite 不是主五臂自然策略估计：

- 不能把 forced miss 的请求率称为自然 planner 请求率；
- 不能把恢复差称为 inferred planner 的端到端产品效果；
- 主矩阵仍独立记录自然 `BOUNDED_NEED_RESOURCE` 触发率；
- forced suite 只回答 typed request + fresh rerun 这条机制链在需要它时能否工作。

本地静态校验：

```text
node experiments/access-frontier/mechanism-suites/lint.mjs
```

lint 证明初始 grant 至少保留一份必要证据、确定遗漏另一份必要证据，且遗漏证据可由 declared catalog 内的请求 envelope 恢复。目前配置包含 `af-dispersion-cross` 和 `af-entropy-low` 两个配对机制 probe。

## 独立 executor

`executor.mjs` 复用正式 runner 的 Broker、worker Prompt、公开 response contract、本地 validator、Canary、JSONL 恢复与 provider 分类，但不修改主五臂 `CONDITIONS`：

- control 映射为 `BOUNDED_INFERRED`，禁用资源请求；
- treatment 映射为 `BOUNDED_NEED_RESOURCE`，允许一次请求，批准后由正式 runner 创建全新 Broker/消息序列 fresh rerun；
- `buildManifest({initialGrantOverrides})` 绕过模型 grant planner，把同一归一化 undergrant 显式冻结进两个 job、result 与 job ID；
- 两臂看到相同的窄化 Catalog（初始 grant + request envelope）、相同 Prompt、task、model、seed 和 budgets；
- 派生 task 使用 `af-forced-undergrant-*` ID，raw manifest/results 写到本目录独立 `runs/`（已忽略），不会与自然五臂 task ID 混合；
- descriptor 另行冻结 suite hash、executor source hash、runner protocol、manifest hash、arm mapping 和 probe identity；executor 在 run 前复核这些身份；
- 独立 summarizer 只输出配对状态、请求/批准/fresh-rerun/恢复计数和 policy 聚合，不复制模型 payload。

纯本地 scripted smoke：

```text
node --test experiments/access-frontier/mechanism-suites/executor.test.mjs
node experiments/access-frontier/mechanism-suites/executor.mjs --smoke
```

smoke 的确定性 client 在 control 只读到 job log 后规范 abstain；treatment 第一次请求缺失 config，第二次从头读回两份证据并通过 hidden truth/provenance。门禁同时断言两个 job seed/initial grant 相同、planner 调用为零、request 获批、恰有两次 attempt、恢复成功且 policy 不变。

真实模型建议先以 1 repeat 做机制 pilot；必须从已提交且干净的 outcome-relevant 实现创建 manifest：

```text
node experiments/access-frontier/mechanism-suites/executor.mjs plan \
  --repeats 1 \
  --model deepseek-v4-flash

node experiments/access-frontier/mechanism-suites/executor.mjs run \
  --concurrency 2 \
  --summary experiments/access-frontier/reports/forced-undergrant-r1-summary.jsonl
```

`run` 仅从环境变量 `EXPERIMENT_KEY` 读取密钥。若 planning 后 executor、suite、runner、依赖、Node、模型、endpoint 或 config 漂移，运行应 fail closed 并要求重建 manifest。`--allow-dirty` 只供 engineering smoke，不得用于正式机制证据。

独立 summary 的解释规则：provider/network/harness failure 从 eligible pair 排除；模型 timeout/无效 completion 是机制能力结果；`recovered=true` 仅指同一 task-repeat 中 control 语义失败且 treatment 语义通过。无论结果多好，都不得把该 recovery rate 写成自然 planner 收益。
