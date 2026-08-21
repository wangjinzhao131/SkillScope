# Senior SWE 真实任务 Skill 组合 prepilot v2 报告

状态：**PREPILOT FAILED / FORMAL EXPERIMENT NOT ALLOWED**

日期：2026-08-22（Asia/Shanghai）

## 一句话结论

一次性 Scope 在两道真实失败任务上把父会话末态缩小约 99.36%，且所有实际启动的资源都被销毁；但 `deepseek-v4-flash` 在 6/6 运行中都没有提交第一阶段的结构化结果，所以目前只能证明隔离有效，不能比较任务表现或长程稳定性。

## 1. 真实任务是怎样选出的

数据源固定为公开的 Senior SWE-Bench v2026.06.2、commit `1212f23a662d2e8d3f321b174735a80be1fdf2e2`。选择器只读取 answer-safe metadata，不读取 solution、oracle、测试正文或历史成绩。

50 个公开任务中有 25 个 Investigate 候选；按资源、timeout、架构和 verifier 条件过滤后，14 个进入预先冻结的候选顺序。任务不是研究者看过成绩后挑选：

- Better Auth 是预先固定的 TypeScript prepilot；
- PostHog 环境构建超过 25 分钟上限，退出；
- Prefect 的锁定开发依赖缓存超过题目声明的 20 分钟构建上限，退出；
- Electric 是冻结顺序中的下一项，也是第一个通过完整资格门的不同 repo、不同语言任务。

最终 prepilot 任务集：

| task | repo / language | 环境 | 断网资格门（3 次） |
| --- | --- | --- | --- |
| `better-auth-fix-api-key-run` | better-auth / TypeScript | `ENV_BUILD_PORT` | no-op 每次 1/4；gold 每次 4/4 |
| `electric-fix-elixir-client-cache` | electric / Elixir | `ENV_BUILD_PORT` | no-op 每次 1/4；gold 每次 4/4 |

两题都来自固定数据集，solver 不含 `/tests`、`/solution`，模型阶段全部断网。官方公开 verifier 只在所有 Scope 销毁后由 sibling 容器运行。

## 2. 比较了什么

三组使用相同模型、seed、四个原子 Skill、工具、预算和真实任务：

| 组 | 组合方式 | 父会话保留什么 |
| --- | --- | --- |
| `INLINE_PERSISTENT` | 四阶段都在根会话 | 全部工作历史 |
| `FLAT_DISPOSABLE` | 一个随用随销 worker 做四阶段 | compact result |
| `COMPOSED_DISPOSABLE` | main Scope 依次调用四个新 leaf；每个 leaf 独立销毁 | Runtime 校验的 typed result 与 artifact handle |

四阶段固定为 investigate → implement → review → repair。模型固定为 `opencode-go/deepseek-v4-flash`，temperature 0，paired seed `20260822`。六个 task-arm 的顺序在调用前冻结。

## 3. 实际结果

| task | 组 | 用时 | 完成阶段 | 原生验证 | 父末态 bytes | 总 tokens | 失败 |
| --- | --- | ---: | ---: | --- | ---: | ---: | --- |
| Better Auth | Inline | 315.2s | 0/4 | 未进入 | 260,452 | 1,895,907 | `MISSING_STAGE_COMPLETE` |
| Electric | Inline | 239.3s | 0/4 | 未进入 | 243,562 | 1,146,816 | `MISSING_STAGE_COMPLETE` |
| Electric | Flat | 416.3s | 0/4 | 未进入 | 1,581 | 1,638,789 | `MISSING_STAGE_COMPLETE` |
| Better Auth | Flat | 324.9s | 0/4 | 未进入 | 1,640 | 217,102 | `MISSING_STAGE_COMPLETE` |
| Electric | Composed | 296.2s | 0/4 | 未进入 | 1,581 | 547,053 | `MISSING_STAGE_COMPLETE` |
| Better Auth | Composed | 754.1s | 0/4 | 未进入 | 1,640 | 572,549 | `MISSING_STAGE_COMPLETE` |

按组中位数：

| 组 | 父末态 bytes | 用时 | 总 tokens |
| --- | ---: | ---: | ---: |
| Inline | 252,007 | 277.2s | 1,521,361.5 |
| Flat | 1,610.5 | 370.6s | 927,945.5 |
| Composed | 1,610.5 | 525.2s | 559,801 |

Flat 和 Composed 相对同题 Inline 的父末态分别下降 99.35% 与 99.37%，配对中位下降 99.36%。这个数只表示失败路径被隔离；Composed 的 coordinator 为 0，是因为没有任何 typed stage 到达 coordinator，不是成功的零上下文编排。各组都失败、每组只有两次且耗时波动大，因此本报告不把 token 或用时中位数解释为成本优势。

## 4. 生命周期要拆成两个问题

原始 `lifecycle.valid` 为 4/6，因为它把两个问题合成一个布尔值：

1. 已经启动的 Scope 是否全部关闭；
2. 成功路径预期的完整拓扑是否全部启动。

拆开后：

- `allStartedScopesClosed`：6/6；
- active Scope：6/6 为 0；
- active container：6/6 为 0；
- `topologyComplete`：4/6；两个 Composed 只走到 main＋investigate leaf，后续三个 leaf 没有启动；
- Sentinel 和 raw transcript 泄漏：0/6。

所以 Composed 的 `lifecycle.valid=false` 是早停导致的拓扑不完整，不是资源泄漏。Raw 不重写，只在分析层显式拆字段。

## 5. 预注册门判定

| 门 | 结果 |
| --- | --- |
| 6/6 进入 native verifier | **失败：0/6** |
| 至少 5/6 有四阶段、非空可用 patch | **失败：0/6** |
| 所有实际启动资源关闭 | 通过：6/6 |
| 无泄漏 | 通过：6/6 |
| telemetry 完整 | 通过：6/6 |
| native 结果不是全 0 / 全 1 | **无法判断** |

task-arm 中位用时为 320.0 秒；单看时间本可容纳 6-task formal，但效果门失败，所以**不选择正式任务集、不启动正式实验、不换更容易的第三道 prepilot 题**。

## 6. 这批证据改变了下一步什么

共同失败不是隔离、容器、verifier 或任务环境，而是 Runtime 把“必须提交 typed result”主要交给提示词约束。模型可以持续调查或用普通文本停下，Runtime只能在事后拒绝。

下一版只检验一个最小机制：阶段工作结束或达到冻结上限后，Runtime 将当前会话的 active tools 暂时收窄为当前 `*_complete`，再发出一次 checkpoint 指令。它继续使用同一阶段会话已经拥有的证据，不把 transcript 复制给父会话；三臂规则完全相同。该步骤是确定性的协议阶段，不按结果选择性触发，也不改变真实任务答案、工具能力或某一实验组预算。

为了节省时间，下一轮按门逐级停止：

1. 先在已排除于正式矩阵的 Electric 上运行 Composed 的 investigate-only capability preflight；必须得到 Runtime-valid typed result并完整销毁资源。
2. 通过后才运行 Electric 的完整 Composed 四阶段；必须形成非空 patch并真正进入 native verifier。
3. 通过后才在同一题补齐 Flat 与 Inline；3/3 可比较后，才允许冻结新的正式真实任务集。

任一步失败都停止，不扩任务、不加 reviewer、不投票、不换模型。这个顺序先验证 SkillScope 最核心的“独立销毁＋结构化返回”链路，再花时间比较任务表现。

## 7. 可复现性

分析命令：

```bash
node experiments/senior-swe-composition/src/prepilot-analysis.mjs \
  --manifest experiments/senior-swe-composition/manifests/prepilot-v2.json \
  --results experiments/senior-swe-composition/runs/prepilot-v2
```

Raw results 保持 Git ignored，六文件 bundle SHA-256：

```text
26de44f2935f8b0804d96fd238c096998b472098b8222b1a9e3bff6f1dd2627d
```

单文件哈希由分析器一并输出。Manifest 生成时 SHA-256 为 `d5b7dcecb50227d561de346797240b3d3fa13f8671e26b02a99cda9dd8a2b558`。
