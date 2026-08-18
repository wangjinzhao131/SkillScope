# SkillScope 研究档案

本目录记录 SkillScope 可行性验证与 Pi 插件开发的完整研究过程。目标不是只保留成功结果，而是让假设、失败、协议变更、原始证据和设计决策都可复盘。

| 文档 | 用途 |
| --- | --- |
| [访问边界实验预注册.md](./访问边界实验预注册.md) | 从未冻结、已 supersede 的 v1 历史草案；保留以防事后改写历史 |
| [访问边界实验预注册_v2.md](./访问边界实验预注册_v2.md) | 已完成 Schema 2 live Pilot 的 data-before freeze、排除、停止规则和解释边界 |
| [高搜索熵访问实验预注册_v1.md](./高搜索熵访问实验预注册_v1.md) | 下一轮五任务、五单元诊断 Pilot；拆分父目录搜索句柄、分片导航、tool budget 与模型 planner |
| [Schema 2 Pilot v1 人工复核](../../experiments/access-frontier/reports/schema2-pilot-v1/README.md) | 70-job 五条件结果、forced-undergrant 机制结果、artifact hashes、失败审阅与严格推断边界 |
| [R1反证与Schema2设计修正.md](./R1反证与Schema2设计修正.md) | dry pilot 对测量契约的反证、公开 response contract、源行 provenance 与 forced-undergrant 设计 |
| [假设与决策记录.md](./假设与决策记录.md) | 假设状态、支持/反驳证据与架构决策 |
| [实验日志.md](./实验日志.md) | 按时间记录每个步骤、失败、协议修订和真实 API 运行 |
| [Zen_API_探测.md](./Zen_API_探测.md) | Luna/GLM 对照与当前 `deepseek-v4-flash` Chat/tool/usage preflight |
| [Pi_0.84.2_API_Spike.md](./Pi_0.84.2_API_Spike.md) | Pi 公共 API、Session、ModelRuntime/Registry 与桥接 Spike；其中 `/tmp` 脚本是历史证据 |
| [安全不变量验证.md](./安全不变量验证.md) | ResourceBroker、Trace 与真实文件适配器的 hostile 测试和边界 |
| [实验实现独立审计.md](./实验实现独立审计.md) | access-frontier Runner 的历史审计快照；当前结论须结合 R1/v1.3 门禁 |
| [插件实现独立审计.md](./插件实现独立审计.md) | Pi 插件的窄路径有条件 GO 与生产级 NO-GO 边界 |

原始机器可读 manifest/results 写入 `experiments/access-frontier/runs/` 或各独立 suite 的 `runs/`，审核后的聚合报告写入 `experiments/access-frontier/reports/`。raw runs 默认被 Git 忽略，因为它们包含隐藏 fixture truth 和模型正文。密钥只从环境变量 `EXPERIMENT_KEY` 读取；客户端与结果写盘均须做 secret 回显回归，报告只保留脱敏断言和 artifact hash。
