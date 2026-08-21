# SkillScope 研究档案

本目录记录 SkillScope 可行性验证与 Pi 插件开发的完整研究过程。目标不是只保留成功结果，而是让假设、失败、协议变更、原始证据和设计决策都可复盘。

| 文档 | 用途 |
| --- | --- |
| [访问边界实验预注册.md](./访问边界实验预注册.md) | 从未冻结、已 supersede 的 v1 历史草案；保留以防事后改写历史 |
| [访问边界实验预注册_v2.md](./访问边界实验预注册_v2.md) | 已完成 Schema 2 live Pilot 的 data-before freeze、排除、停止规则和解释边界 |
| [高搜索熵访问实验预注册_v1.md](./高搜索熵访问实验预注册_v1.md) | 已完成的五任务、五单元诊断 Pilot；拆分父目录搜索句柄、分片导航、tool budget 与模型 planner |
| [Planner输出预算实验预注册_v1.md](./Planner输出预算实验预注册_v1.md) | 在高熵 Pilot 观察到 10/10 fallback 后新增；配对检验 catalog 宽度与 planner 输出 token 预算 |
| [ResourceSet真实仓库快照实验预注册_v1.md](./ResourceSet真实仓库快照实验预注册_v1.md) | 已完成的48-job仓库内snapshot设计；比较exact files、聚合search handle、directory root与Oracle |
| [父上下文与嵌套SkillScope实验预注册_v1.md](./父上下文与嵌套SkillScope实验预注册_v1.md) | 当前主线：随用随销的主/子Scope、Runtime结构化返回、父上下文占用与端到端稳定性的四条件直接实验 |
| [父上下文与嵌套SkillScope实验报告](../../experiments/parent-context/reports/latest/report.md) | 60-trial live结果：父上下文显著下降、正确率持平、当前嵌套实现以更多调用树token和延迟换取上下文隔离 |
| [SkillScope组合拓扑实验预注册_v1.md](./SkillScope组合拓扑实验预注册_v1.md) | 当前延伸主线：固定同一main/原子Skill和调用数，只改变并行、两个串行方向与自适应typed information flow |
| [SkillScope组合拓扑实验人工复核](../../experiments/composition-topology/reports/latest/README.md) | 72-job live结果：方向匹配与自适应机制有效，但负对照与provenance稳定性门失败，不能声称普遍稳定性提升 |
| [SkillScope路由权责实验预注册_v1.md](./SkillScope路由权责实验预注册_v1.md) | 当前后续：固定Runtime自动child-evidence binding，只比较模型路由与作者声明/Runtime侧路由的36-trial配对设计 |
| [SkillScope路由权责实验人工复核](../../experiments/routing-authority/reports/latest/README.md) | 36-trial结果：Runtime声明路由17/18、模型路由15/18；自动child evidence 36/36有效，另保留leaf执行波动与外推边界 |
| [Senior SWE真实任务Skill组合实验预注册_v1.md](./SeniorSWE真实任务Skill组合实验预注册_v1.md) | 当前真实任务主线：固定Senior SWE-Bench v2026.06.2，比较Inline、单worker和main＋四个独立销毁leaf对父上下文与长程稳定性的影响 |
| [Schema 2 Pilot v1 人工复核](../../experiments/access-frontier/reports/schema2-pilot-v1/README.md) | 70-job 五条件结果、forced-undergrant 机制结果、artifact hashes、失败审阅与严格推断边界 |
| [High-search-entropy Pilot 人工复核](../../experiments/access-frontier/reports/entropy-frontier-v1/README.md) | 50-job 父搜索句柄、分片导航、调用预算与 planner 结果；含 reporting amendment |
| [Planner output-budget probe 人工复核](../../experiments/access-frontier/reports/planner-budget-v1/README.md) | 60-trial planner-only 结果；区分 forced-tool 协议完成、catalog 宽度、预算与实际选择性 |
| [ResourceSet snapshot Pilot 人工复核](../../experiments/access-frontier/reports/resource-set-holdout-v1/README.md) | 48-job真实仓库snapshot结果；分层报告答案、严格provenance、成本、安全与一题测量歧义敏感性 |
| [R1反证与Schema2设计修正.md](./R1反证与Schema2设计修正.md) | dry pilot 对测量契约的反证、公开 response contract、源行 provenance 与 forced-undergrant 设计 |
| [假设与决策记录.md](./假设与决策记录.md) | 假设状态、支持/反驳证据与架构决策 |
| [实验日志.md](./实验日志.md) | 按时间记录每个步骤、失败、协议修订和真实 API 运行 |
| [Zen_API_探测.md](./Zen_API_探测.md) | Luna/GLM 对照与当前 `deepseek-v4-flash` Chat/tool/usage preflight |
| [Pi_0.84.2_API_Spike.md](./Pi_0.84.2_API_Spike.md) | Pi 公共 API、Session、ModelRuntime/Registry 与桥接 Spike；其中 `/tmp` 脚本是历史证据 |
| [安全不变量验证.md](./安全不变量验证.md) | ResourceBroker、Trace 与真实文件适配器的 hostile 测试和边界 |
| [实验实现独立审计.md](./实验实现独立审计.md) | access-frontier Runner 的历史审计快照；当前结论须结合 R1/v1.3 门禁 |
| [插件实现独立审计.md](./插件实现独立审计.md) | Pi 插件的窄路径有条件 GO 与生产级 NO-GO 边界 |

原始机器可读 manifest/results 写入各实验自己的`runs/`（例如`experiments/access-frontier/runs/`和`experiments/routing-authority/runs/`），审核后的聚合报告写入相应`reports/`。raw runs 默认被 Git 忽略，因为它们包含隐藏 fixture truth 和模型正文。密钥只从环境变量 `EXPERIMENT_KEY` 读取；客户端与结果写盘均须做 secret 回显回归，报告只保留脱敏断言和 artifact hash。
