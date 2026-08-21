# Senior SWE 正式 Pilot：真实任务资格与选定记录

日期：2026-08-22（Asia/Shanghai）

状态：**4/4 任务资格通过；正式任务集与24-job manifest已冻结；正式模型尚未调用**

## 结论

按预注册候选顺序访问的前四题全部通过，因此正式任务集停止扩展并固定为：

1. `prefect-fix-resolve-race-condition` — Prefect / Python
2. `firezone-fix-connlib-align-device` — Firezone / Rust
3. `better-auth-fix-resolve-dynamic-baseurl` — Better Auth / TypeScript
4. `electric-perf-array-filter-eval` — Electric / Elixir

它们来自 Senior SWE-Bench v2026.06.2 的真实公开 Investigate 任务，覆盖四个仓库和四种主要语言。任务是在任何正式 `deepseek-v4-flash` 调用前，仅依照冻结顺序、ARM 可运行性和原生判分极性选出的；没有按题目预期难度、gold 形状或模型成绩换题。

## 资格结果

每题从 clean baseline 独立执行三次 no-op 与三次官方 gold。六次均断网判分、基础设施有效且 runner error 为空。

| 任务 | 环境层 | no-op，3次 | gold，3次 | 单次wall范围 | 结论 |
|---|---|---:|---:|---:|---|
| Prefect race condition | `ENV_BUILD_PORT` | `2/3` | `3/3` | 10.2–11.3s | 通过 |
| Firezone connlib device | `NATIVE_ARM` | `1/4` | `4/4` | 20.7–24.6s | 通过 |
| Better Auth dynamic baseURL | `ENV_BUILD_PORT` | `2/7` | `7/7` | 4.7–30.0s | 通过 |
| Electric array filter | `ENV_BUILD_PORT` | `4/6` | `6/6` | 8.6–18.3s | 通过 |

这里的 `ENV_BUILD_PORT` 只表示为离线重放改变了依赖获取/缓存方式，不改变源码、base commit、lock、依赖版本、任务说明、tests、solution 或 verifier：

- Prefect：上游镜像把公开 verifier 所需的 dev group 留给联网 `test-setup.sh`；派生镜像只按同一 `uv.lock` 预缓存 `uv sync --frozen --group dev`。
- Better Auth：同一 pinned pnpm tarball 经 npm registry client 的安装曾在同仓库 prepilot 环境中耗尽大部分 1800 秒预算；改为直接下载完全相同版本 tarball，再由 npm 本地安装。
- Electric：同一 Electric/Hex 获取阶段曾真实 `:timeout`；按 Hex 错误建议使用低并发与120秒请求超时，依赖身份不变。
- Firezone：未修改的上游 Dockerfile 在本机 ARM64 构建并预编译公开测试路径，无需移植。

## 镜像身份

| 任务 | solver image ID | verifier sibling ID |
|---|---|---|
| Prefect | `sha256:58af9b897baa191ab3708125c9b9a647f5f67fdc3083198a032cd29666855400` | `sha256:45939c0acbfe7eea3a2e78b0f85d099bd85174939dd46ec229994bb80c33b34f` |
| Firezone | `sha256:2dc356823e15db880a37e8043690c54fdcb7aa671abb9639e1cf9adba770b4d1` | `sha256:3e1dac89e272b529af7953aa28b0fdaa4193c78544b740854b196179a5d6b630` |
| Better Auth | `sha256:782776f5a979db00887706a6b332a303c1d0024f2075e714a906ff5370b82831` | `sha256:5e30ec21d7b6f1ce9ec31857c386290a1edb05ff9592210ee0e516d99fd51eba` |
| Electric | `sha256:9b7785eea1d3cdca079c322ee4041b198ff0f8d995c620318fd998176cf8215c` | `sha256:9a27730ea1b77542cc68f8e683c1c99201a10e8abdd7d82bc2bc3cbd027251c8` |

四组镜像均为 Linux `arm64`。solver 不含 evaluator tests/solution；verifier sibling 只增加上游公开 `tests/test.sh` 声明的 Python runner imports，并在所有 Skill Scope 销毁后使用。

## Raw记录完整性

资格 raw 位于 Git ignored 的 `experiments/senior-swe-composition/runs/formal-qualification/`：

| 任务 | raw SHA-256 |
|---|---|
| Prefect | `01521008d6fe5cd92a3a6a94e16d832795c2400de2df59114e3a4b60d19f79ff` |
| Firezone | `433fbde7bdcb1b49e28c6b8064f71d5a4e7492d14efbe95d034681cec003ce8d` |
| Better Auth | `5ca36d43203117e3d2fa21e1ae7f2cf9c16fa7f00d33c244af396efa95524e20` |
| Electric | `fc0d97a501143370d5c86a9263e4f93074377f058fcc6e8e16c39feb65632508` |

按文件名字典序连接四份 raw 后的 bundle SHA-256 为 `2754c3df55c6bb70724af9abddd00bc73eca43377d61fa655f64bb8f05e137e6`。Raw 不进入 Git，因为包含上游 evaluator 的运行细节；上表和正式 manifest 固定其身份。

## 正式实验设计

正式矩阵为 `4任务 × 3种相同Skill组合 × 2重复 = 24 jobs`：

- `INLINE_PERSISTENT`：四阶段历史保留在父会话；
- `FLAT_DISPOSABLE`：四阶段留在一个结束后销毁的 worker；
- `COMPOSED_DISPOSABLE`：main 依次调用四个 fresh disposable leaf，只接收 Runtime 校验的结构化结果与 artifact handle。

三臂使用相同的 investigate→implement→review→repair Skill、repo 工具、总预算和 Runtime checkpoint。每个 task-repeat 的三臂共享 seed；全体 job 按冻结 identity hash 排序，顺序运行，避免资源竞争。

主要观察不是“谁更像 subagent”，而是组合边界是否同时做到：父上下文更小、持久 worker/coordinator 上下文更小、四阶段和原生判分不更差、同题两次更一致。比较以 task-repeat 配对进行；如果上下文下降但完成率或原生成绩下降，就明确报告为交换成本。

一次性正式清单为 `experiments/senior-swe-composition/manifests/formal-pilot-v1.json`：

- clean implementation commit：`f927958e040e2d093657435472b052276276656b`
- manifest SHA-256：`05fff665eb3dfbf5998c905c7924349d49a0df2890cfda7d81eb6ac0b9192e2a`
- 24-job order hash：`48ebdfc4b13a952e821ed3f6d4f8d4c37b3c232fe4dde4b75c82aa9af91d8f24`
- candidate-order hash：`8cfd21f90c0cb72ae8dd8270f512b5a88ab2a5f4117ba7bcd7f0ad7f993e94a8`

生成器要求 clean worktree，并逐项拒绝候选顺序漂移、资格少于三轮、no-op/gold极性错误、非ARM64或缺失镜像、任务集不是前四个repo互异通过项。清单用独占创建模式落盘，避免静默覆盖。

## 预实验给出的可行性证据

v2 的六条真实运行证明 disposable 方案能把父末态缩小约99.36%，但三臂都未形成第一个 typed checkpoint，不能比较任务表现。v3 在同一永久排除任务上加入三臂一致的 Runtime checkpoint 后，Inline、Flat、Composed 3/3 都完成四阶段、形成非空 patch 并进入有效原生 verifier；完整链路中位约12.8分钟。

因此本轮正式设计没有把能力门失败误当成组合效果，也没有为某一臂增加专属重试。按 v3 中位用时估算，24 jobs 约需5.1小时模型 wall time；17小时总停止线仍保留。

## 当前边界

本报告只证明任务真实、环境可重放、判分有稳定极性，以及24-job设计可执行。它不包含正式模型效果，也不能从四道任务声称普遍优越。正式模型调用现在具备启动条件，但本轮没有把计划项冒充已执行结果。
