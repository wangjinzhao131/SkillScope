# Planner output-budget probe 人工复核

状态：**已完成的 post-hoc 机制 probe；不是 worker 端到端效果或自然授权收益实验。**

运行日期：2026-08-18（Asia/Shanghai）

模型与端点：`deepseek-v4-flash`，`https://opencode.ai/zen/go/v1`

预数据基线：`a488a1a5a6b201d72c248570981f0a04158b484c`，`implementationDirty=false`

设计见 [Planner 输出预算实验预注册 v1](../../../../docs/research/Planner输出预算实验预注册_v1.md)。同五个任务、两个 repeat，在单一 root catalog 与 16-shard opaque catalog 上交叉 512、1024、2048 completion-token 预算，共 60 个 planner-only trials。descriptor 在首次 provider call 前一次冻结。

## 身份与完整性

```text
planHash = sha256:935110a21a1c4446871e95220f7643d948f2ea27ea2184a450bfa4fbc236ad9b
sourceTreeHash = sha256:5feb3fa6d1e37cb160a373fa6f8e38c0b3547ba1b4be904970344119d47ac453
descriptor file SHA-256 = f7ae6ef5552c747d9869fc21c9032f5ee714228976b62f32148d6fece01f8fb6
results file SHA-256 = 8318eea4e5511ebf0ada8949dac296bd96d22d1f5867af199222495ce06086b0
summary file SHA-256 = dca01aa5ef812b4c76eb8e7a578dc2f5fe145e1a28732a2642f5660577ee16eb
generated report SHA-256 = 353fee8744ffbda7a51ece0fc502613e5e316aac9780c7c059dd74e857697d8c
```

60/60 trial 有且仅有一个 result，全部完成；没有 provider、network、harness 或 cancellation exclusion，也没有重跑。密钥精确值与 raw `SCOPE_CANARY_*` 扫描均为零命中。descriptor 冻结并在运行时核验 client 的模型、API base 与 provider protocol；probe v1 没有把 provider response 的 `model` 字段另存到 result，这是可复现性限制，不应把 descriptor identity 表述成逐响应 model attestation。

## 结果

“合法 plan”只表示返回通过严格校验的 `select_grants`；“覆盖”表示该选择包含两份必要证据，不表示选择最小。

| Catalog | Planner max tokens | 合法 plan | 首轮 / repair 成功 | Fallback-all | 覆盖 / 合法 | Median selected | Median total tokens | Median duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| root | 512 | 10/10 | 10 / 0 | 0/10 | 10/10 | 1 | 790 | 2.39 s |
| root | 1024 | 10/10 | 10 / 0 | 0/10 | 10/10 | 1 | 808 | 2.16 s |
| root | 2048 | 10/10 | 10 / 0 | 0/10 | 10/10 | 1 | 797.5 | 2.06 s |
| sharded | 512 | 0/10 | 0 / 0 | 10/10 | 0/0 | NA | 3,816 | 10.06 s |
| sharded | 1024 | 3/10 | 0 / 3 | 7/10 | 3/3 | 16 | 4,840 | 18.09 s |
| sharded | 2048 | 9/10 | 5 / 4 | 1/10 | 9/9 | 16 | 4,631 | 20.36 s |

Root 512 的 10/10 首轮成功排除了“模型普遍不支持 forced tool”这一解释。Sharded 512 的 20/20 attempts 都以 `finish_reason=length`、无 tool call 结束；1024 只在 repair 时成功 3 次；2048 恢复到 9/10。由此有把握地说：**catalog 宽度与 planner 输出预算存在强交互，512 是当前 16-shard 协议的不足预算。**

但所有 12 个合法 sharded plan（1024 的3个、2048 的9个）都选择了 16/16 entries。覆盖率因此是 12/12，却没有任何授权面收窄。catalog 的路径与目录名被故意设计为 opaque，模型没有足够元数据区分必要 shard；增加输出预算只能让它更可靠地表达“全选”。

## 设计结论

1. 不把 LLM grant planner 作为 opaque catalog 的默认最小授权器；当前证据只支持把它视作可失败的协调步骤。
2. 如果保留 planner，`maxTokens`、finish reason、tool-call presence 与 repair 必须独立冻结和记录；512 不能再是隐藏常量。
3. 不再运行“2048 planner + 24-call sharded worker”来重复已知机制：合法 planner 产生的仍是全 16 shard grants，而同 grants、同 worker budget 的 `SHARDED_ALL_24` 已是 0/10。新的可辨识实验应改变导航接口，而不是再为全选 planner 增加成本。
4. 下一原型应让一个逻辑 ResourceSet 聚合多个 exact-file grants，并在服务端跨集合 search；授权集合不变，导航由 N 个路径降为一个 handle。

本 probe 只有五个同构合成 family、两个 repeat、一个模型。它不能证明任何真实 repository 的收益，也不能把 planner protocol success 当成 worker Hard Pass。生成的 [summary](../planner-budget-v1-summary.jsonl) 与 [report](../planner-budget-v1-report.md) 是可审阅聚合；raw descriptor/results 保持 Git ignored。
