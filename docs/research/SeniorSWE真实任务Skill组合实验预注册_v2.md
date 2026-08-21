# Senior SWE 真实长任务 Skill 组合实验预注册 v2

状态：**V2 PREPILOT FROZEN / NO V2 TASK-MODEL CALLS YET**

日期：2026-08-22（Asia/Shanghai）

模型：`opencode-go/deepseek-v4-flash`，temperature 0，paired seed `20260822`

数据：Senior SWE-Bench v2026.06.2，commit `1212f23a662d2e8d3f321b174735a80be1fdf2e2`

本文是 v1 的证据驱动修订。没有在 v1 失败后覆盖原文或删除 raw 记录；除下面明确列出的四项修正外，研究问题、三臂、四阶段、工具、预算、隔离、指标和解释边界继续使用 v1。

## 1. 研究问题不变

同一个真实长程修复任务上，相同的 investigate→implement→review→repair 原子 Skill：

- 全留在父会话 `INLINE_PERSISTENT`；
- 留在一个执行后销毁的 worker `FLAT_DISPOSABLE`；
- 由 main Scope 调用四个逐个销毁、只返回 Runtime-valid typed result 与 patch handle 的 leaf `COMPOSED_DISPOSABLE`；

三种组合是否会改变父/编排上下文占用、原生任务结果、后阶段失败率和长程稳定性。SkillScope 的核心处理仍是**独立销毁的 Scope 组合和结构化跨边界返回**，不是更换模型、追加 reviewer、投票、重试或给某组更多工具/预算。

## 2. 为什么 v1 停止

v1 的真实 preflight 得到三条否定证据：

1. `posthog-fix-llm-gateway-add` 的固定环境在 25 分钟上限内未构建完成；v1 明确禁止换题补齐，所以 v1 不能放行。
2. Better Auth Inline 首次调用在 investigate 使用 25 次请求、上下文增长到约 43.8K provider tokens 后，以普通文本结束，没有调用 Runtime completion；审计发现 prompt 同时写了“只能用 exec/patch”和“必须调用 completion”，契约自相矛盾。
3. 只安装 requests/jinja 的 verifier sibling 对不同任务不充分；Electric 公共 runner 还会导入 `unidiff`。这使早期 `0/0` 资格运行只能算基础设施无效。

这些结果都保留在 `实验日志.md` 与 Git ignored raw records；v2 不把它们改写成模型或任务能力结果。

## 3. v2 只改四件事

### 3.1 结构化完成说明去掉矛盾

所有三臂、所有四阶段共同使用同一说明：repo 工作使用 `container_exec`，允许编辑的阶段可使用 `container_apply_patch`，唯一其他允许工具是当前 `${stage}_complete`；普通文本结束会被 Runtime 拒绝。

没有增加 completion retry、turn、tool call、timeout 或任一臂的特殊机会。源码 SHA-256：`2f674ca983cace3258cef7efce0cbb55d9fd4636e97a5023048238366bb89d4a`；回归测试明确拒绝旧的矛盾句。

### 3.2 第二道 prepilot 改为机械选出的 Electric

Better Auth 保留。第二题不根据模型成绩选择，而是沿 v1 在任何 formal qualification 前冻结的候选顺序，依次做环境资格：

- PostHog：环境构建 25 分钟超时；
- Prefect：原始镜像可构建，但断网需要的 locked dev dependency cache 在其声明 20 分钟上限内未完成；
- Electric：下一候选，原始构建只在 Hex 获取固定 tarball 时超时，窄移植后构建成功，gold/no-op 3/3 稳定。

所以 v2 task set 固定为：

| task | repo / language | instruction SHA-256 | 环境层级 |
| --- | --- | --- | --- |
| `better-auth-fix-api-key-run` | better-auth / TypeScript | `701c91d64c6fae0b8d2591984c0c535987b0225dbcef9db61211bc82b37e88f9` | `ENV_BUILD_PORT` |
| `electric-fix-elixir-client-cache` | electric / Elixir | `701095e6bdbebb386c2ef73e5164f9f6a7b9c40965725e4ab799393dcb40fd92` | `ENV_BUILD_PORT` |

两题都永久排除于 v2 正式效果矩阵；v1 已指定的 PostHog 也继续排除。选择器只读取 `task.toml` 的 answer-safe prefix。Prefect 曾在机械选中后被研究者误打印完整 metadata，这一偏差已记录；内容不进入模型、selector、manifest outcome field 或任务排序。

### 3.3 Electric 只移植固定构件的获取参数

未修改 Electric Dockerfile 在 `pg_query_ex-0.9.0` tarball 处得到 Hex `:timeout`。派生 recipe 只把 `mix deps.get` 改成 Hex 错误信息自己建议的 `HEX_HTTP_CONCURRENCY=1 HEX_HTTP_TIMEOUT=120 mix deps.get`。

不改变依赖、锁文件、base commit、源码、instruction、solution、verifier 或 tests。原/派生/replacement SHA-256：

```text
79c1160ab9aa259f0c6403dc96379a7ea3160e5798a7dbf210ceba1ba0339533
6fc021136e41f6fabcb07e3bbba825d8d62e764c67acbbf2a979d01a48da9fc3
a1cf052c8a4ff2118111d2c7ac2c720498a42a588897a79345f0351097423bec
```

### 3.4 Verifier sibling 使用上游公开完整依赖

solver image 仍不含 `/tests`、`/solution`，模型阶段始终 `network=none`。verifier sibling 只增加上游 `tests/test.sh` 公开声明的 pytest、requests、jinja2、litellm、pydantic、unidiff、pygments、ast-grep-py，并兼容 Debian PEP 668；hidden tests 仍只在所有 Scope 销毁后由 evaluator 临时复制。

| task | solver image ID | verifier image ID | 资格结果 |
| --- | --- | --- | --- |
| Better Auth | `sha256:c224353351ecbcbb3b97f9f99c2c37dc571444816c981d471686ad31dafb1a7d` | `sha256:1ad75827d8fd5db834132bd786382425dde4b61fe94cdb58e718bcb76d6edf52` | 3× no-op 1/4；3× gold 4/4 |
| Electric | `sha256:ab6d3b876c8b8a4c7a8e8acaa0efac6b2c0d2e1be010724b2c0c263477cd2edc` | `sha256:6fc9236e3355b85a6fc339f5e2ad0061f9281437558c778f0471525f36124a5b` | 3× no-op 1/4；3× gold 4/4 |

六次 stability qualification 均 infrastructure valid、runner error 为空并在断网容器中完成。

## 4. v2 prepilot 矩阵和顺序

仍为 `2 tasks × 3 arms × 1 repeat = 6 task-arms`。同一任务三臂共享 seed；全局顺序在任何 v2 模型调用前按 `sha256("skillscope-senior-v2:20260822:" + taskId + ":" + arm)` 升序冻结：

1. Better Auth / `INLINE_PERSISTENT`
2. Electric / `INLINE_PERSISTENT`
3. Electric / `FLAT_DISPOSABLE`
4. Better Auth / `FLAT_DISPOSABLE`
5. Electric / `COMPOSED_DISPOSABLE`
6. Better Auth / `COMPOSED_DISPOSABLE`

order hash：`791f774f2974048e9a4a657be520d1a7b0f69834ef045df3f0b8cd32620bac33`。

v1 Better Auth Inline 的旧运行不进入 v2 分母。v2 不重用它的模型正文、patch 或结果。

## 5. 放行与停止门

正式实验只有在以下全部通过后才可能开始：

1. 6/6 进入 native verifier；
2. 至少 5/6 形成 Runtime-valid、非空、可应用 final patch；
3. 6/6 生命周期完整，所有 disposable Scope/容器在 verifier 前销毁；
4. 无 solution、tests、gold、Sentinel、secret 或 child transcript 泄漏；
5. telemetry 完整，native 结果不是全 0 或全 1；
6. 最多一个真正外部失败，且仅按 v1 冻结规则从 clean state 重试一次。

任一门失败：保留实际结果，停止 formal task selection；不换第三道更容易的题，不增加预算或补跑某个实验臂。若 completion 修正后仍无法进入后阶段，它就是本装置对 `deepseek-v4-flash` 的可行性结论。

样本量与 17 小时停止规则继续沿用 v1：六个 task-arm 中位数 ≤20 分钟才考虑 6-task formal；20–30 分钟只考虑 4-task formal；>30 分钟直接停止正式效果实验。

## 6. 预定解释

v2 prepilot 首先回答“真实链路是否可比较”，不凭六次结果宣称 SkillScope 提升稳定性。可能的结论仍是：

- Composed 明显减小父/编排上下文且任务结果不差：支持继续正式实验；
- Flat 有效但 Composed 不优于 Flat：只支持单 disposable worker，不支持当前四 leaf 组合；
- Composed 上下文更小但总 token/时间或失败更多：结论是“上下文换成本”；
- 六次装置门不通过：只交付可行性、失败机制和下一版设计证据。

