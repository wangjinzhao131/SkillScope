# SkillScope Composition Topology Experiment

本实验固定同一个 `workflow-compose` main Skill 和同一个 `inspect-contextual-evidence` 原子 Skill；每个条件都恰好创建一个main Scope和两个原子child Scope，只改变执行顺序以及第一个Runtime-valid结果是否传给第二个Scope。

状态：**设计与实现已冻结；四臂真实工程preflight通过；尚无72-job live效果数据。** 完整因果口径、任务机制、成功门和停止规则见[预注册](../../docs/research/SkillScope组合拓扑实验预注册_v1.md)。

## 四个条件

| 条件 | 组合 |
| --- | --- |
| `PARALLEL_JOIN` | 两个相同原子Skill调用并行，均无上游结果 |
| `CONSTRAINT_FIRST` | constraint结果传给observation调用 |
| `OBSERVATION_FIRST` | observation结果传给constraint调用 |
| `ADAPTIVE_ORDER` | main根据公开routing cue选择串行方向 |

六个family分为constraint-first、observation-first和independent各两个；三个repeat、四条件，共72个配对trial。方向依赖packet没有有效上游时必须返回`AMBIGUOUS/UNKNOWN`，因此本实验主要验证typed information flow和路由，而不是自然工作负载中依赖任务的发生率。

## 本地门禁

```bash
npm run test:composition
npm run composition:smoke
```

Smoke不调用模型；它验证24个family-condition机制结果、相同Skill版本、相同调用数和预期方向。

## Clean baseline后的live步骤

以下命令必须等实现、测试、预注册和依赖进入同一个clean commit后运行：

```bash
zsh -ilc 'npm run composition:preflight'
npm run composition:plan
zsh -ilc 'npm run composition:run'
npm run composition:analyze
```

模型冻结为`opencode-go/deepseek-v4-flash`，endpoint为`https://opencode.ai/zen/go/v1`，单进程writer、默认单并发。Raw manifest/results写入`experiments/composition-topology/runs/`并被Git忽略；只提交审核后的聚合报告。

## 解释边界

- 第一轮固定调用数，不包含投票、重试、双向都跑或额外reviewer。
- direction-matched提升首先是组合表达力证据，不直接等于自然任务收益。
- independent family是负对照；若四条件在这里明显分化，应先检查实现和预算不等价。
- 正确率提升必须与父上下文、tree token、延迟和生命周期一起报告。
