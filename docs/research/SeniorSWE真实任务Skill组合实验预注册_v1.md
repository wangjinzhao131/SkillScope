# Senior SWE 真实长任务 Skill 组合实验预注册 v1

状态：**PREPILOT DESIGN FROZEN / NO TASK-MODEL OUTCOMES YET。** 本文在首次 `deepseek-v4-flash` 真实任务调用前冻结研究问题、候选池、三条件、预实验、选题规则、时间上限和解释边界。本文与 Harness 必须进入同一 clean commit，并由该提交生成 manifest；预实验产生后若修改 outcome-relevant 规则，必须新建 v2，不得覆盖本协议。

日期：2026-08-22（Asia/Shanghai）

模型与端点：`opencode-go/deepseek-v4-flash`，`https://opencode.ai/zen/go/v1`

本地执行上限：单并发；从 clean-run 首次环境资格命令开始计时，总墙钟不超过 17 小时。

## 1. 根本问题

本轮只研究：

> 在同一个真实、需要定位—实现—审查—修复的长程软件任务上，把相同的原子 Skill 组合成一组执行完即销毁的独立 Scope，并且只让 Runtime 校验过的结构化结果和内容寻址 artifact 跨边界，能否减少根父会话与编排会话的上下文占用，同时保持或改善长程任务成功率与重复稳定性。

主要处理因素是 **Skill 组合和 Scope 生命周期**，不是换 Prompt、增加工具、追加 reviewer、投票或为某组增加预算。Scope 边界自然造成的额外协调请求是待测成本，必须计入整树 usage。三条件固定相同的：

- 任务、base commit、instruction、模型、seed 与 provider；
- 四个阶段 Skill 的 prompt bytes、顺序、工具、转移规则和 Schema；
- 每阶段及整题的 turns、tool calls、时间和重试机会；
- 每阶段的初始容器状态和已声明的上一阶段 artifact。

访问 Profile、ResourceSet、planner、动态补权、模型选择、安全攻击和官方排行榜都不是处理因素。

## 2. 真实任务集

唯一数据源为 [Senior SWE-Bench v2026.06.2 公开 Harbor 数据仓](https://github.com/snorkel-ai/senior-swe-bench-v2026.06/tree/v2026.06.2)：

- tag：`v2026.06.2`；
- annotated tag object：`fea57b9fb7e17a22a6ce71c1a9c1bc5444ef9f75`；
- peeled data commit：`1212f23a662d2e8d3f321b174735a80be1fdf2e2`；
- 机械盘点为 50 个公开任务，其中 `segment=investigate` 25 个、`segment=design` 25 个。

本轮候选池仅包含这 25 个 `metadata.segment="investigate"` 任务。[官方说明](https://senior-swe-bench.snorkel.ai/blog/2026-06-16-how-it-works) 将 Investigate-and-Fix 定义为来自真实故障或性能问题、需要运行时调查的任务；数据还记录上游 repo、PR、base commit 和 merge time。这比自行编写的小题更能产生长上下文压力。

禁止：

- 修改 instruction、重写任务或自行生成新任务；
- 看见模型成绩后换成更容易的题；
- 使用 `metadata.narrative.solution`、`metadata.oracle_scope`、`solution/`、`tests/judge/` 或历史模型成绩选题；
- 把“定位成功”当成完整修复成功。

## 3. 三个组合条件

每题固定四个原子 Skill：

1. `investigate`：理解症状、定位代码、尝试复现，返回证据化诊断和计划；
2. `implement`：根据诊断实现修复，返回 patch artifact；
3. `review`：在已应用 implement patch 的干净阶段容器中审查并运行可见测试，返回结构化发现；
4. `repair`：根据已声明的诊断、patch 和审查结果完成最终修复，返回 final patch artifact。

| 条件 | Session / Scope 拓扑 | 跨阶段信息 | 根父会话可见内容 |
| --- | --- | --- | --- |
| `INLINE_PERSISTENT` | 四个 Skill 直接在 root Session 的同一历史中顺序执行 | messages、tool results 和 typed checkpoint 全保留 | 全部工作过程与最终结果 |
| `FLAT_DISPOSABLE` | root 只启动一个随用随销 worker Scope；四个 Skill 在该 Scope 的同一历史中顺序执行 | worker 内保留全部历史 | 一个 Runtime-valid final result；worker transcript 不返回 |
| `COMPOSED_DISPOSABLE` | root 启动一个 main Skill Scope；main 依次启动四个全新 leaf Scope，leaf 完成即销毁 | 下一 leaf 只收到 Runtime-valid stage result 与 artifact handle | 一个 Runtime-valid main result；main/leaf transcript 不返回 |

组合条件的冻结拓扑：

```text
Root Parent Session
  └─ disposable main Skill Scope
       ├─ investigate leaf → DiagnosisResult  → dispose
       ├─ implement leaf   → PatchResult      → dispose
       ├─ review leaf      → ReviewResult     → dispose
       └─ repair leaf      → FinalPatchResult → dispose
     → MainResult → dispose → Root Parent
```

三条件的每个阶段都从同一基础镜像新建容器，只应用已声明的上一阶段 patch artifact。Inline 和 Flat 也执行同样的容器重建；唯一关键差异是模型历史保留在哪里、是否在阶段间销毁，以及跨边界是否只有 typed result。

## 4. Runtime、工具与结构化返回

原子阶段的求解容器只暴露固定的受限工具：`exec`、`read`、`list`、`search`、`apply_patch`、`export_patch`。三条件的**阶段工具**、容器资源和网络规则完全相同。求解容器不挂载 benchmark `solution/`、`tests/` 和 task package，只挂载上游 base repo；`instruction.md` 由控制器作为任务输入提供。

Composed main 只拥有 `scope_invoke_stage`、`artifact_metadata` 和 `main_complete`，不能直接读取 repo、执行命令或修改 patch。Runtime 根据 manifest 强制它按 investigate→implement→review→repair 各调用一次，拒绝跳过、重复、改序、额外 leaf 或 main 自己求解。Inline/Flat 的同样四个阶段由控制器在冻结边界切换；因此三个条件的原子工作机会相同，Composed 新增的只是在 Runtime 约束下消费 typed result 的编排成本。

最小跨 Scope 数据：

- `DiagnosisResult`：`status`、`summary`、`hypotheses`、`evidenceRefs`、`reproduction`、`nextAction`；
- `PatchResult`：`status`、`summary`、`artifactRef`、`artifactHash`、`artifactBytes`、`changedPaths`、`evidenceRefs`；
- `ReviewResult`：`status`、`decision`、`findings`、`testSummary`、`reviewedArtifactHash`、`evidenceRefs`；
- `FinalPatchResult`：`status`、`summary`、`artifactRef`、`artifactHash`、`artifactBytes`、`changedPaths`、`resolvedFindings`、`evidenceRefs`；
- `MainResult`：`status`、`finalArtifactRef`、`finalArtifactHash`、四阶段 status 和整树 usage。

`artifactRef` 是 Runtime 保管的内容寻址引用，不是 child 自行指定的宿主路径。Runtime 必须校验 hash、大小、unified-diff 语法、base commit 和可修改路径；应用失败、hash 不匹配、额外字段或证据引用不完整均 fail closed。原始 transcript、任意工具输出和未声明文件不得穿过 Scope 边界。

每阶段最多 40 个 model/tool turns，整题最多 160；单个 task-arm 上限 45 分钟。超限是能力失败，不得为该条件追加预算。

## 5. Gold 隔离与原生 verifier

资格校验、求解和评分必须是三个独立权限域：

1. **Qualification process** 可在隔离容器执行上游 `solution/solve.sh`，但只向选题器返回 task ID、`goldPass`、`noopPass`、运行时、架构类别、镜像和 verifier hash。
2. **Solver process** 只能看到 instruction、base repo 和自身工具结果；不得看到 gold patch、solution 日志、hidden tests、rubric、oracle scope 或 gold/no-op 细节。
3. **Evaluator process** 在 solver 结束且 Scope 全部销毁后，在新容器应用 final patch，执行上游 `tests/test-setup.sh` 和 Stage 1 `tests/run_verify.py`，解析 `verifier_results.json`。

本实验不执行 `run_judge.py rubric`、taste judge 或其他 LLM 评分。`nativeVerifierPass=true` 当且仅当 runner 无错误、至少产生一个测试、全部原生测试通过；同时保存 `passed/total` 和失败类别。

每个候选题在 manifest 生成前使用全新容器运行：

1. 快速门：no-op 1 次、gold 1 次；
2. 方向正确后运行稳定性门：no-op 3 次、gold 3 次；
3. gold 必须 3/3 pass，no-op 必须 0/3 pass，六次均产生有效非空 verifier 结果；
4. runner crash、空测试、下载失败或非确定结果均为环境不合格，不能算作 no-op 失败证据。

Gold 只证明任务与 verifier 可运行，不进入模型 prompt、Skill 路由、任务排序或效果指标。

## 6. ARM 可行性门

当前执行机为 Apple Silicon，Docker 可用资源约 4 CPU / 8 GiB。对冻结数据的源码审计确认：25 个 Investigate 任务中，3 个 Gitea 和 3 个 Turborepo 环境 Dockerfile 直接下载 `linux-amd64` / `linux-x86_64` 二进制。因此不能根据 Dockerfile 存在就宣称任务可用。

每题先分类：

- `NATIVE_ARM`：上游 task bytes 不变，在 `linux/arm64` 成功完成 build、gold/no-op 稳定性门和一次断网重放；
- `ARM_PORT`：只对环境搭建脚本做可审计的架构参数化，例如把 Go/Protobuf 下载映射到 `arm64/aarch64`；不得改 instruction、base repo、solution、verifier 或测试；
- `INELIGIBLE`：无法在时限内构建、需要 x86 语义、gold/no-op 不稳定或不能断网重放。

`ARM_PORT` 必须保存原 Dockerfile hash、port patch、替换二进制的官方 URL/checksum、派生 Dockerfile hash 和 image digest。只有 gold/no-op 极性不变才可进入候选池，并在报告中与 `NATIVE_ARM` 分层。

ARM port 挑战题固定为 `gitea-fix-diff-highlight-overlap`，只验证 port 方法，不进入两个模型 prepilot 任务。它仍须通过冻结选择器才可能进入正式任务。

资格阶段可联网构建镜像和填充缓存，并为同一 task 冻结两个兄弟镜像：不含 `solution/tests` 的 solver image，以及只在所有 Scope 销毁后由 evaluator 启动的 verifier image。二者分别记录 digest；后者可预装 verifier 依赖和 hidden tests，但绝不挂载给 solver。digest 冻结后，solver 和 native verifier 重放都必须 `network=none`，模型 API 由宿主控制器调用。不能断网重放的题标为 `INELIGIBLE`，不得临时只放开某一条件。

### 6.1 已有非模型可行性证据

本轮已进行一次不产生任务结果的 Gitea ARM 构建探测：基础镜像进入原生 ARM Ubuntu 构建阶段，但首次 apt 下载长时间无进展后被主动取消，没有生成可用任务镜像。这只证明架构基础镜像可启动，**不算 ARM 门通过，也不算模型预实验**。

### 6.2 首次任务模型调用前的环境构建附录

Clean baseline `3bed3e4` 后、任何 gold/no-op 和任务模型结果前，两个固定 prepilot 的未修改 Dockerfile 暴露了可复现的冷构建故障：Better Auth 的 `npm install` 在同一固定 pnpm tarball 上长期低速，耗尽大部分声明 build timeout；PostHog 的 `git fetch --unshallow 2>/dev/null || true` 下载失败后吞掉错误，导致下一步找不到已经固定的 base commit。

为继续验证实验链路，允许新增 `ENV_BUILD_PORT`，但规则比一般 Dockerfile 修改更窄：

- 只能在未修改 Dockerfile 已真实失败或达到声明 build timeout 后启用；
- 只能改变取得已固定构件的方式，不能改变构件版本、base commit、repo 文件、instruction、solution、verifier 或 tests；
- 必须断言原 Dockerfile hash与唯一替换点，保存 replacement、派生 hash、image identity 与失败原因；
- 必须通过同一 gold 3/3、no-op 0/3、非空原生 verifier 和断网重放门；
- 报告单列为 `ENV_BUILD_PORT`，不得写成 `NATIVE_ARM`，也不得用其绝对构建/执行时延外推官方环境。

两个已冻结 recipe 只做：Better Auth 从与 npm 相同的版本化 URL 直接下载 `pnpm-10.30.2.tgz` 后本地安装；PostHog 只 fetch Dockerfile 下一行已经固定的 `423e9cf...` commit，而不是下载不需要的完整历史。recipe 进入新 clean baseline 后才可运行资格门；若极性门不通过，任务仍为不合格，不继续修补。

## 7. 模型预实验

在固定正式任务 ID 前，先运行两个永久排除于正式效果矩阵的 prepilot 任务：

- `better-auth-fix-api-key-run`：TypeScript library，verifier timeout 600 秒；
- `posthog-fix-llm-gateway-add`：Python service，verifier timeout 600 秒。

选择它们是为了在不同 repo/语言栈验证端到端链路，不基于 gold patch 大小或既有模型成绩。

模型调用前先做 scripted smoke：

- Inline 恰有四阶段；Flat 恰有一个 worker Scope；Composed 恰有一个 main 和四个不同 leaf Scope；
- 三组四阶段的 prompt/schema/tool/budget hash 一致；
- patch 可从相同 base 在下一容器重建，未声明文件不会传递；
- success、schema failure、timeout、cancel 均 dispose，最终 `activeScopes=0`；
- 每阶段新鲜 `SCOPE_SENTINEL_<run>_<stage>_<random>` 不进入上层 messages 或 artifact。

Live prepilot 固定为 `2 tasks × 3 conditions × 1 repeat = 6 runs`。同一任务三条件共享配对 seed，条件顺序由 manifest seed 打乱。放行正式实验必须同时满足：

1. 两题均通过 ARM 与 gold/no-op 门，6/6 runs 进入原生 verifier；
2. 至少 5/6 返回合法、非空、可应用 final patch；
3. 无 gold、hidden tests、solution、Sentinel 或 transcript 泄漏；
4. 6/6 有完整逐轮上下文、整树 usage、artifact 与 lifecycle 遥测；
5. `nativeVerifierPass` 或 `passed/total` 不是全 0 且不是全 1；
6. 最多一个可归因于 provider/network/container 的外部失败，且按冻结规则重试后恢复。

任一门禁不通过时，保留实际结果并停止选定正式目标；不得换更容易的题补到通过。修复链路或修改条件后必须建立 v2 并重做 prepilot。

## 8. 正式选题与时间自适应

正式任务从排除两道 prepilot 后的 23 题中机械选择。先在任何 formal-task gold/no-op 运行前生成公开元数据候选顺序，再按顺序做资格校验，收集到目标样本数后立即停止继续构建，避免为排序而验证全部 23 题。选择器只可读取：

- task ID、repo、segment、公开 stack/tags；
- 声明的 build/verifier timeout、静态架构风险和冻结 image digest；
- qualification 的资格 boolean；实测运行时只进入成本日志，不参与正式题排序。

选择器不得读取 prepilot 模型成绩、gold 内容、oracle scope 或历史 leaderboard。

预先生成候选顺序：

1. 排除上游 verifier timeout 高于 600 秒的任务；
2. 最大化不同 repo 数，同 repo 最多一题；
3. repo 数相同时最大化 stack 覆盖；
4. 再按 task 中声明的 `build_timeout_sec + verifier.timeout_sec` 升序；
5. 仍相同时按 `sha256("skillscope-senior-v1:" + taskId)` 升序。

默认先顺序访问无静态 x86 风险的任务；只有通过门的 `NATIVE_ARM` 不足以填满样本量时，才访问 `ARM_PORT` 队列。某题资格不通过时记录原因并访问冻结顺序中的下一题；这不是根据模型成绩换题。达到目标数后，正式任务就是前 N 个资格通过者，不再以实测时长、gold 形状或 prepilot 成绩二次排序。完整候选顺序及其 hash 在 prepilot 放行、首个 formal qualification 前写入 manifest。

样本量由 6 个 prepilot task-arm 从 solver 启动到 native verifier 完成的中位墙钟冻结：

- 中位数 `<=20 分钟`：目标 `6 tasks × 3 conditions × 2 repeats = 36 runs`；
- `>20 且 <=30 分钟`：目标 `4 tasks × 3 conditions × 2 repeats = 24 runs`；
- `>30 分钟`：停止正式效果实验，只交付可行性与成本结论。

同一任务的三条件×两重复组成不可分割的六-run task block。块内顺序由 manifest seed 打乱，单并发执行。完成一块后，只有按 prepilot p90 仍有足够时间完成下一整块才启动；到 17 小时或不足一整块时停止，不留下为某一条件单独增样的半块。

## 9. 指标和预定对比

### 9.1 任务表现与稳定性

记录：

- `nativeVerifierPass`、`passed/total`；
- final patch 是否非空、可应用且只修改 repo 内路径；
- 四阶段是否 Runtime-valid，final hash 是否正确引用 implement/review 链；
- 无诊断、非法 patch、schema invalid、超时、review/repair 断链、native tests fail 等失败类别。

`Run Hard Pass` 要求：final patch 合法可应用，四阶段 Runtime-valid，拓扑符合条件，所有计划 Scope dispose，无 Sentinel/gold 泄漏，且 `nativeVerifierPass=true`。

长程稳定性同时报告：

- 同一 task-condition 两次重复的 Hard Pass 与 native pass 一致率；
- 两次都通过、都失败、一成一败的任务数；
- review/repair 后两阶段失败率、schema failure 和 patch-chain 断裂；
- 每条件最差 task，而不只报告总体均值。

两次重复只提供方向性证据，不是生产 SLA。

### 9.2 上下文、成本和生命周期

每次 provider request 前分别记录 root parent、Flat worker 或 Composed main/leaf 的：

- provider context/input tokens；缺失时另记 tokenizer/bytes 估算，两者不混合；
- message JSON bytes、tool-result bytes、阶段、累计 turns；
- `peakContext`、最终 context、各 request context tokens 相加形成的离散 `contextAUC`；
- root、coordinator、leaf 和整树的 tokens、API calls、模型时间、工具时间、容器和 verifier 时间。

Flat worker 是 Flat 的 `coordinator`，Composed main 是 Composed 的 `coordinator`。这用于检查“main 下的独立子 Skill”是否也减少编排会话占用，而不只是把 root 上下文搬到一个大 worker。

生命周期必须机械证明：

- Flat 每个 eligible run `started=disposed=1`；
- Composed 恰有一个 main、四个不同 leaf，`started=disposed=5`；
- 所有退出路径最终 `activeScopes=0`；
- child transcript 与 Sentinel 在上层 message corpus 命中为 0。

### 9.3 预定对比和支持门

配对单元是 task-repeat：

1. `FLAT_DISPOSABLE - INLINE_PERSISTENT`：单个随用随销 worker 对 root 上下文的效果；
2. `COMPOSED_DISPOSABLE - FLAT_DISPOSABLE`：多个独立销毁 leaf 与 typed boundary 对 coordinator 和稳定性的附加效果；
3. `COMPOSED_DISPOSABLE - INLINE_PERSISTENT`：SkillScope 完整产品包的净效果。

“核心方向获得支持”须同时满足：

- Composed 相对 Inline 的 median root `contextAUC`、最终 provider context 和 message bytes 至少降低 30%；
- Composed coordinator 相对 Flat coordinator 的 `contextAUC` 或最终 message bytes 至少一项降低 30%，另一项不增加超过 10%；
- Composed `nativeVerifierPass` 不低于 Inline 超过 10 个百分点；
- Composed 重复一致率不低于 Inline，后两阶段失败率不高于 Inline；
- 所有 eligible Scope 均 Runtime-valid、已销毁且无 transcript/Sentinel/gold 泄漏。

10 个百分点是探索性产品门，不是正式非劣置信界。报告必须给出任务级配对计数、差值方向和最差任务。

## 10. 运行、失败和停止规则

1. 数据提交、任务顺序、模型、端点、四 Skill hash、Schema/tool/resource hash、seeds、条件顺序、时间与重试规则均进入 manifest 和 job identity。
2. 正式 run 从同一 clean baseline 启动；每阶段和 verifier 使用新容器，保存 image digest、base commit 和 patch hash。
3. MAX_TURNS、MAX_TOOL_CALLS、模型 timeout、invalid schema/patch、自行中止和测试失败均为 capability failure，不重跑。
4. 只有 provider 429/5xx、宿主断网、Docker daemon/container start 失败或已证明的 verifier 基础设施中断允许从 clean state 重试一次；两个 attempt 都保留。
5. 任一 gold/hidden-test 泄漏、child transcript/Sentinel 泄漏、错误拓扑被计为 eligible、artifact 校验 fail open 或 `activeScopes>0`，立即停止效果解释。
6. 首个正式模型调用后不增加预算、repair、条件、任务或重复；时间限制只能按冻结顺序停止新的完整 task block。

## 11. 解释边界

本轮最多可以声称：在 Senior SWE-Bench v2026.06.2 公开 Investigate-and-Fix 的小型 ARM-eligible 子集上，三种固定 Skill 组合的父上下文、长程稳定性、原生测试表现和总成本差异。

不得声称：

- 取得官方完整分数或 leaderboard 名次；
- `nativeVerifierPass` 等于通过 rubric、taste judge 或其他 LLM 裁判；
- `ARM_PORT` 与官方未修改 x86 运行完全等价；
- 父上下文降低等于整树 Token、延迟或成本降低；
- 凭 2 个 prepilot 或 4—6 个正式任务证明生产稳定性。

若 Composed 降低父/coordinator 上下文但整树 Token、延迟或失败率更高，结论必须写成“上下文换成本”。若 Flat 有效而 Composed 不优于 Flat，只支持单 worker，不支持当前多 leaf 组合。只有重复一致率提高或后阶段失败率下降时，才可称“长程稳定性改善”。

## 12. 实验记录和交付

执行时必须同步交付：

- `docs/research/实验日志.md`：追加资料选择、源提交盘点、ARM 构建/port、gold-noop、smoke、live prepilot、正式选题、停止理由和结论；
- `experiments/senior-swe-composition/`：保存 qualification/port/prepilot/formal manifests、image digests、results、context traces、lifecycle、artifact hashes 和 native verifier 结果；
- 审阅后的 Markdown 报告：任务级配对表、三个预定对比、上下文曲线、成本、失败归因、ARM 分层与解释边界。

原始模型正文、hidden verifier 内容和 gold patch 不提交进 Git；提交报告只包含审阅过的聚合、任务级结果、hash 和必要失败摘要。每次失败和协议修订都追加记录，不因最终成功而删除早期证伪证据。
