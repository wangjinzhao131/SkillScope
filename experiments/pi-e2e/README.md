# Pi Extension 真实 E2E

本目录有两层真实模型证据。`run-live.mjs` 使用确定性外层宿主，隔离验证 Extension/子 Session 主链；`parent-fixture/` 还用于“npm tarball → fresh install → 真实父 Pi → 已安装 Extension → 真实子 Session”，把父模型委托也纳入 smoke。两者都不是生产安全证明。

实际覆盖链路：

```text
Pi Extension 注册 scoped_skill_run
→ 父 ModelRegistry 中的 opencode-go/deepseek-v4-flash
→ 短命内存 CredentialStore 和子 ModelRuntime
→ 新 SessionManager.inMemory AgentSession
→ BOUNDED 真实文件快照与 ResourceBroker
→ scope_read / scope_search
→ scope_complete
→ Runtime-owned SkillResult
→ cwd 外 Trace
```

合成项目只授权 `logs/import.log`，另放置一个 `private/out-of-grant.txt`。成功门禁要求：

- 结果为 `SUCCESS`，且通过 `analyze-evidence` output schema；
- 引用 `logs/import.log`；
- 审计集合证明授权文件已读，`private/` 未读且未进入模型可见集；
- `scopeId`/usage/trace/timestamps 由 Runtime 生成；
- Trace 的 manifest/events/result 在 scoped project 之外完整落盘；
- Trace 为 `metadata-only-v1`，业务路径/正文/summary/data 不以明文持久化；
- 审核后的合成 summary 和 Trace 均不含 `EXPERIMENT_KEY`。

从仓库根运行（密钥需已存在于登录 shell）：

```bash
zsh -ilc 'node experiments/pi-e2e/run-live.mjs'
```

脚本仅从进程环境读取密钥，不打印、不哈希、不复制到 `.env`。默认审核摘要写入 `experiments/pi-e2e/results/latest.json`；真实 Trace 位于临时 project 的外部兄弟目录，脚本验证 metadata-only 投影、记录三个文件的 SHA-256 和事件类型后删除临时目录。

2026-08-18 的源码宿主最终复跑为 `SUCCESS`：11.69 秒、3 turns、3 tool calls、7,911 tokens；授权文件的 physical/actual/model-visible count 均为 1，项目根 list 被拒绝。审核 artifact 同时断言业务明文与 key 不在 Trace。

已安装 tarball 的真实父 Pi smoke 使用 [parent-fixture/PROMPT.md](./parent-fixture/PROMPT.md) 和 exact-file grant。该次 fresh install 也为 `SUCCESS`：子 Scope 11.10 秒、2 turns、2 tool calls、5,359 tokens；审核摘要见 [installed-parent-latest.json](./results/installed-parent-latest.json)。临时 npm prefix、Pi config 与原始 Trace 已移入废纸篓，未提交。

同一链路已经编码为重放脚本；它会 pack 当前 tree、安装到 `mkdtemp`、运行真实父 Pi、检查 Trace/密钥并在 `finally` 删除临时目录。它的 180 秒首次实跑发生外层 timeout；上限已调为 300 秒，但在下一次成功实跑前，只能称“已编码、待验证稳定重放”：

```bash
zsh -ilc 'node experiments/pi-e2e/run-installed-parent-live.mjs'
```

这些 E2E 只支持 Pi 0.84.2、可信进程内代码、explicit API-key `openai-completions`、exact-file BOUNDED 的功能性 MVP。它们不声称是 OS sandbox，也不支持 OAuth/native/custom stream、目录/PROJECT 泛化、并发容量或对恶意主机写者的 TOCTOU 隔离。
