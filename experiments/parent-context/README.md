# Parent Context / Nested SkillScope Experiment

这是当前直接对应 SkillScope 根本目标的实验 Harness：比较父 Agent 直接工作、自由文本临时 Agent、单层结构化 SkillScope、主 Skill 下两个独立子 SkillScope，观察父上下文占用和端到端稳定性。

状态：**实现与本地 smoke 阶段；尚无 live 结果。** 访问边界、动态补权、ResourceSet 和安全 Profile 不是本实验处理因素。完整设计、停止规则和成功门见[预注册文档](../../docs/research/父上下文与嵌套SkillScope实验预注册_v1.md)。

## 四个条件

| 条件 | 工作方式 | 回到父会话的内容 |
| --- | --- | --- |
| `INLINE_PARENT` | 父 Agent 直接读取两份完整 packet | 原始工具结果 |
| `EPHEMERAL_FREEFORM` | 一个全新、用完销毁的 Session 读取两份 packet | 最终自由文本 |
| `SKILLSCOPE_FLAT` | 一个全新 SkillScope 读取两份 packet | Runtime-valid `SkillResult` |
| `SKILLSCOPE_NESTED` | main Scope 启动两个互不继承历史的 child Skill Scope | 两个 typed child result 汇总成 typed main result |

四组父 Agent 最后都必须用同一个严格 `parent_complete` 返回 `decision`、两个 exact facts 和初始 memory code。五个 workflow family、三个 repeat、四个条件，共 60 个父任务。

## 本地门禁

```bash
npm run typecheck
npm run test:pi
npm run test:parent-context
npm run parent-context:smoke
```

本地 smoke 不调用模型；它检查 5×4 任务形状、同块字节、结构化结果和“只有 Inline 的父上下文含 child sentinel”。真实嵌套的 Scope ID、父子关系、授权不扩大、并发限制和 dispose 由 `tests/pi/nested-runtime.test.js` 覆盖。

## Clean baseline 后的 live 步骤

Manifest 创建会拒绝 outcome-relevant dirty tree。必须先把实现、语料、本 README、预注册和依赖提交到同一个 clean commit，再用登录 shell 中已有的 `EXPERIMENT_KEY`：

```bash
zsh -ilc 'npm run parent-context:preflight'
npm run parent-context:plan
zsh -ilc 'npm run parent-context:run'
npm run parent-context:analyze
```

当前模型冻结为 `opencode-go/deepseek-v4-flash`，Pi transport 标识为 `openai-completions`，endpoint 为 `https://opencode.ai/zen/go/v1`。Harness 在模型对象的 `samplingParams` 中冻结 `temperature=0` 和每个 family-repeat 共享的 `seed`。

Raw manifest/results 位于 `experiments/parent-context/runs/`，被 Git 忽略，因为它们含隐藏 truth、packet bytes 和模型输出。只提交人工复核后的聚合报告。Runner 是单进程 writer；每个 capability failure 不重跑，provider error 最多按 manifest 冻结规则额外尝试一次并保留 attempt 摘要。

## 测量

每个 trial 记录父级 provider context tokens、Pi 估算 context tokens、模型可见 message bytes、tool-result bytes、child sentinel 是否进入父消息、Parent Hard Pass、family 内三次一致性、调用树 tokens/延迟，以及 Scope start/dispose 账本。

父上下文变小不自动等于总成本变小。若 Nested 只是把 tokens 或延迟搬到子 Scope，最终报告必须明确写“上下文换成本”。本 Pilot 只有五个 family，不能当生产 SLA，也不回答 SkillScope 是否优于所有 Subagent 实现。
