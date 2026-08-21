# Senior SWE 结构化收口能力预注册 v3

状态：**CAPABILITY GATE FROZEN / NO V3 MODEL CALLS YET**

日期：2026-08-22（Asia/Shanghai）

模型：`opencode-go/deepseek-v4-flash`，temperature 0，seed `20260822`

数据：Senior SWE-Bench v2026.06.2，commit `1212f23a662d2e8d3f321b174735a80be1fdf2e2`

## 1. 这不是效果实验

v2 的六个真实 task-arm 都在 investigate 阶段没有提交 Runtime-valid typed result。它们证明 disposable Scope 能把失败过程从父会话隔离出去，但没有产生 patch 或原生验证结果，不能比较长程稳定性。

v3 只回答一个更小的问题：**Runtime 真正约束结构化返回后，这条真实四阶段链路能否形成可比较观测？** 在能力门通过前，不冻结正式任务集、不扩大样本、不声称 SkillScope 改善任务效果。

## 2. 唯一机制修正

每阶段仍先运行同一个原子 Skill。工作阶段中 active tools 由 Runtime 精确限制：

- investigate / review：`container_exec`＋当前 `*_complete`；
- implement / repair：`container_exec`＋`container_apply_patch`＋当前 `*_complete`。

如果工作阶段没有提交 completion，Runtime进入一个确定性的 checkpoint phase：

1. 保留同一阶段会话已有历史，不创建知道更多信息的新模型；
2. active tools 收窄为当前 `*_complete`，repo工具全部关闭；
3. 只允许使用会话中已有证据提交结构化结果；
4. checkpoint 最多4 turns、1次tool call、120秒；仍没有合法completion就fail closed。

每阶段总wall budget仍为600秒：工作阶段最多使用前480秒，预留最多120秒给checkpoint；工作turn/tool上限仍为40/40。三臂完全相同，不按组、不按任务结果选择性增加调用。该checkpoint是同一Skill调用协议的收口阶段，不是失败后从clean state重做任务，也不把child transcript复制给父会话。

源码 SHA-256：

```text
live-harness.mjs       53d8d7a41e425e96315fe937081df5ef71cdf53d38ada216851d26c3e68068f5
protocol.mjs           a271730906e4cc72791a35eb73911f49dad603ccb712c090694ccbb29c1c1dd7
cli.mjs                d1be350dc1e1267cb902498cc63536b7402b940d37a7781f44a4a5876c62907f
live-harness.test.mjs  6f01a41c095026e9de07eaee8b9a4d1f1d71316e517fe59b987b600bebf859c1
```

## 3. 为什么只用 Electric 做门槛

固定 `electric-fix-elixir-client-cache`，因为它已经通过3次断网no-op/gold资格门、verifier约8秒、v2 Composed只用296秒，是当前已验证真实题中最省时的核心组合探针。它和Better Auth一样已永久排除于未来正式矩阵，因此不会污染正式效果样本。

环境不变：

```text
solver   sha256:ab6d3b876c8b8a4c7a8e8acaa0efac6b2c0d2e1be010724b2c0c263477cd2edc
verifier sha256:6fc9236e3355b85a6fc339f5e2ad0061f9281437558c778f0471525f36124a5b
```

模型不看tests、solution或gold；Scope工作区断网；native verifier仍只在所有Scope销毁后运行。

## 4. 逐级运行与停止门

每一级只在前一级通过后运行：

### Gate A：Composed investigate-only

只运行 Electric / `COMPOSED_DISPOSABLE` 的 investigate。通过要求：

- 恰好1个Runtime-valid investigate result；
- stage protocol记录completion发生在work或checkpoint；
- composed-main＋investigate-leaf恰好2个Scope，started=disposed=2，active Scope/container=0；
- 无Sentinel/transcript泄漏。

该级不运行verifier，也不计任务正确性。

### Gate B：完整 Composed

运行同题完整 investigate→implement→review→repair。通过要求：

- 4/4 typed stages；
- implement和repair产生可应用、非空artifact；
- 5个Scope全部销毁后才进入native verifier；
- verifier infrastructure valid；
- 无泄漏。

native pass是探索性结果，不是本能力门的必要条件。

### Gate C：Flat 与 Inline 可比性

按 Flat、Inline 顺序各运行一次完整链路。通过要求与Gate B相同，除各自冻结的Scope数量外。只有三臂3/3都形成四阶段patch并进入有效native verifier，才说明真实效果实验具备最基本可比性。

任一级失败立即停止剩余级别；不换题、不改prompt、不增加预算、不追加reviewer、投票或模型。真正外部/provider故障只按既有规则从clean state重试一次，并单独标记；普通能力失败不重跑。

## 5. 预定解释

- Gate A失败：当前模型/SDK组合连Runtime-only completion phase也不能稳定提交schema，本方向暂停。
- Gate A通过、Gate B失败：typed checkpoint可用，但四阶段真实链路或artifact交接仍不可行。
- Gate B通过、Gate C失败：当前机制只在部分组合可执行，不能做公平三臂效果实验。
- 三门都通过：只证明三臂可比较；随后才从冻结候选队列资格筛选新的正式真实任务集，并另行预注册效果样本与阈值。

不论哪种结果，v2 raw记录和结论都不覆盖。
