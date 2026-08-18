# High-search-entropy Pilot 人工复核

状态：**已完成的探索性机制诊断；不是确认性实验或真实仓库外部有效性证据。**

运行日期：2026-08-18（Asia/Shanghai）

模型：`deepseek-v4-flash`

预数据基线：`2aa7aab454e75de101acc18a29d28d73eb1aef73`，`implementationDirty=false`

设计见 [高搜索熵访问实验预注册 v1](../../../../docs/research/高搜索熵访问实验预注册_v1.md)。五个语义 family × 两个 repeat × 五个 cell 共 50 jobs；descriptor/manifests 在首次任务调用前一次冻结，没有中途增加预算、样本或重跑能力失败。

## 冻结身份与数据完整性

```text
planHash = sha256:7db65be3aa4c18127240d260e49c85e6cc1adba77b32f7459f7c34eca302c223
sourceTreeHash = sha256:f2a1cd7ac702e71344a497dfff130aacd99d8d0c48ff528cef7567abbfe1ea34
descriptor file SHA-256 = 8a58519fc05533f7109b9208f364924af15053850d8aebc0f0986c1351dacaa7
```

每个 cell 的 manifest/result 均为 10 行，50 个 job 与 50 个 result 一一对应；没有 provider、network、harness、external-cancellation 排除或 supersession。

| Cell | Manifest file SHA-256 | Results file SHA-256 |
| --- | --- | --- |
| `ORACLE_FILE_24` | `7f125a3b2c64d7cce4a0e45885a7dc18470fca4104e2054425f09e4dff5a14c8` | `d9c67f1691430de5173482b79ec1e2d0b8473d34fc3abbba848dfb161e966e97` |
| `ROOT_HANDLE_24` | `6b0c23a13482ed2d2324a7b5648aab9ee094776d91eaeba7e57ec55c6ba2de3c` | `91c0c07d369d66846cd9e00e39c70a137e1da71e14ee4ec83731f104fa0447f9` |
| `SHARDED_ALL_24` | `ce28a47f859adf479193eb7e08c6a66ffca91ebfa7c76e0acaebba0d1d58a55d` | `d25e1b7f181815421339a6c83c6b6b0b8aa86ee0ac6a8c5cdfce1be27341c71d` |
| `SHARDED_ALL_40` | `e5bf348987e0cf3bda7a82509ba56c1c598146872b8cf676914d8ea7365ba230` | `3bed3243fbc04d37f700f42d4b87c611505cd27320f8f0d1f3bc77c1dbab8bfd` |
| `SHARDED_PLANNER_24` | `3778214acc5c327caadf2703e7df115581380b12d3d3a452693a45a20fa15ef0` | `9adf286912fb46847e379b81fc75195829e2927c6ce6c8dfbf5e72d72ebb11fe` |

密钥精确值与 raw `SCOPE_CANARY_*` 扫描均为零命中。Policy Pass 为 50/50，Canary model-visible 与 exfiltration 都是 0/50。这只说明本次合成观测未发现边界突破，不是零泄漏率证明。

## 结果

下表采用 post-run reporting Schema 1.1：read surface 只统计 `actualReadSet` 中真实存在的 virtual-project 文件；原 v1.3 `surface.actualReadFiles` 还把递归 list/search 触及的目录路径计入“文件数”。manifest override 也不再误记为模型 planner observation。raw jobs、Hard Pass、Token、duration 与 tool-call 计数没有改变。

| Cell | Hard Pass | 错误 | Median tools | Median total tokens | Median duration | Median grant/read files |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `ORACLE_FILE_24` | 10/10 | 无 | 3 | 4,033 | 5.78 s | 2 / 2 |
| `SHARDED_ALL_24` | 0/10 | 9 `MAX_TOOL_CALLS`；1 `MISSING_CONTROL_CALL` | 25 | 20,249.5 | 21.90 s | 16 / 16 |
| `SHARDED_ALL_40` | 7/10 | 3 `MAX_TOOL_CALLS` | 39.5 | 41,980.5 | 33.66 s | 16 / 16 |
| `ROOT_HANDLE_24` | 9/10 | 1 `MAX_TOOL_CALLS` | 11 | 20,911 | 20.90 s | 16 / 16 |
| `SHARDED_PLANNER_24` | 0/10 | 9 `MAX_TOOL_CALLS`；1 `MISSING_CONTROL_CALL` | 25 | 27,485.5 | 32.99 s | 16 / 16 |

预定配对差：

- `ROOT_HANDLE_24 − SHARDED_ALL_24`：Hard Pass `+0.90`，平均 tool calls `−13.2`、tokens `−3,503.3`、duration `−2.08 s`；
- `SHARDED_ALL_40 − SHARDED_ALL_24`：Hard Pass `+0.70`，平均 tool calls `+12.5`、tokens `+18,950.8`、duration `+12.45 s`；
- `SHARDED_PLANNER_24 − SHARDED_ALL_24`：Hard Pass `0`，但额外消耗平均 4,696.8 tokens 与 12.53 s；
- `ROOT_HANDLE_24 − ORACLE_FILE_24`：Hard Pass `−0.10`，平均多 8.4 calls、15,677.1 tokens 与 13.57 s。

## 假设更新

### H-010：父目录搜索句柄优于分片导航——探索性支持

Root 与 Sharded-all 授权和实际读取的文件面同为 16；变化是模型能否在一次工具调用中跨该集合检索。24-call 下 Root 为 9/10、Sharded 为 0/10，且 Root 平均少 13.2 次调用。因此最直接的解释不是“扩大读取面”，而是**授权集合与导航拓扑应该分开设计**：一个 ResourceSet 可以继续由精确 grants 构成，同时暴露跨集合的 server-side search handle。

Root 仍有一次 signing repeat 以第 25 次调用终止，所以父句柄不是成功保证；模型仍可能反复 list/search/read。

### H-011：提高预算可恢复分片任务——部分支持，但不适合作为主要修复

40-call 将 Sharded 从 0/10 提到 7/10，证明上一轮并非任务不可解；但三个 task-repeat 仍在第 41 次调用失败，而且成功是以约 1.9 万额外 tokens 和 12.45 秒额外时延换得。提高预算可作为诊断或尾部容错，不应替代更好的检索接口。

### H-012：planner 是独立瓶颈——成立，但原因被修正

Planner cell 的 10/10 trial 都不是“选择了错误 shard”，而是两次 planner response 都没有 `select_grants` call，completion tokens 每次恰好用满 512，随后 fallback-all。因而当前证据首先指向 planner 输出预算/forced-tool 协议，而不是 opaque metadata 下的选择算法。新的 [Planner 输出预算预注册](../../../../docs/research/Planner输出预算实验预注册_v1.md) 将 root/sharded catalog 与 512/1024/2048 token 交叉；在其数据产生前不修改这个 0/10 结果。

## 设计结论

1. 保留 exact-file Oracle/静态 resolver 作为低成本上界；它在本批 10/10 且只需 median 3 calls。
2. 为 BOUNDED 增加“集合授权 + 聚合搜索”抽象，而不是让模型逐目录扇出，也不是退回 PROJECT。集合 handle 不应自动扩大底层 file set。
3. planner 的 max output tokens 必须成为独立、manifest-frozen 配置，并记录 finish reason/tool-call presence；不能继续藏在 512 常量里。
4. raw tool budget 不是主要架构杠杆：40-call 能部分救回，但成本高、仍有失败。

## Reporting amendment 与限制

首次冻结 executor 生成的 summary/report SHA-256 分别为 `92372f33130405fae19f0ecd1e475c849c35743db8a7511a2d3164dc1578d96d` 与 `fbcd7853124dd79fc05038f88afcf4a2608b841ef3b1e748c87bbf626ca6f9d4`；副本保留在被 Git 忽略的 raw runs 目录。其能力结果正确，但 read-file label 与 planner denominator 有上述报告 bug。

修正后的 [summary JSONL](../entropy-frontier-v1-amended-summary.jsonl) 和 [report](../entropy-frontier-v1-amended-report.md) 不覆盖原文件；对应 SHA-256 为 `d45c5252a72d704c9a9434d5da9353ddc3810f1b28baf4f5658870ba406b0635` 与 `e764f32f972fe2ad98b4ee71eb2e5d73b03cdf60d19d4e1cb924c08226598887`。

本实验仍只有五个合成模板、两个 repeat、一个模型和同构的 16-shard 布局。它没有真实 repository holdout，不比较普通 Subagent，也不识别自然 NEED_RESOURCE 收益。结论足以指导下一个 ResourceSet/search-handle 原型，但不足以给生产 Profile 排名或非劣声明。
