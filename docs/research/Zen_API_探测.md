# Zen Go API 独立探测：`gpt-5.6-luna`

## 记录元数据

- 探测日期：2026-08-17（Asia/Shanghai）
- Base URL：`https://opencode.ai/zen/go/v1`
- 目标模型：`gpt-5.6-luna`
- 目标能力：普通响应、单函数调用、工具结果续接、`usage`、`temperature`、`seed`
- 鉴权来源：交互式 `zsh` 继承环境变量 `EXPERIMENT_KEY`
- 密钥处理：只在请求进程内展开；没有打印、写入文件、哈希或复制密钥
- 官方依据：[OpenCode Go / Endpoints](https://opencode.ai/docs/go#endpoints)，访问时页面标注最后更新于 2026-08-16

## 结论先行

本轮不能证明 `gpt-5.6-luna` 具备题设中的 `/chat/completions` 能力，原因有两层，且两层均已获得直接证据：

1. **接口假设不成立。** OpenCode 官方模型表把 `gpt-5.6-luna` 映射到 `POST /responses` 与 `@ai-sdk/openai`，而不是 `POST /chat/completions`。`/chat/completions` 上的普通请求返回 HTTP 403，函数工具请求返回 HTTP 400，响应体却是缺少内容、终止原因和 `usage` 的 `chat.completion` 外壳。
2. **正确接口受到区域限制。** 改用官方指定的 `POST /responses` 后，上游明确返回 HTTP 403：`This model is not available in your region.`。Cloudflare trace 显示请求国家为 `CN`、接入 PoP 为 `LAX`。

因此，普通响应、函数调用闭环、`usage`、`temperature` 和 `seed` 对 **Luna 本身**均应标记为 `BLOCKED_BY_REGION` 或 `NOT_VERIFIED`，不能把 HTTP 403 或 JSON 外形误报成支持。控制组 `glm-5.1` 在同一密钥、网络和 `/chat/completions` 上完整成功，排除了“环境变量未继承”“Bearer 密钥无效”“整个网关不可用”这三种解释。

## 探测前假设

| 编号 | 假设 | 证伪条件 | 结果 |
| --- | --- | --- | --- |
| H1 | Luna 可直接使用 `/chat/completions` | 官方声明使用其他接口，或请求不能得到有效 2xx completion | **证伪** |
| H2 | `Authorization: Bearer` 可用 | 同密钥控制模型返回 401/403 鉴权错误 | **支持** |
| H3 | Luna 能完成单函数调用及工具结果续接 | 首次工具调用不能产生有效 `tool_call` | **未验证；接口错误且区域阻断** |
| H4 | 响应包含可计量的 `usage` | 有效响应或错误响应不含 `usage` | **Luna 未验证；控制组支持** |
| H5 | `temperature`、`seed` 被显式接受 | 返回字段级 4xx | **Luna 不可判定** |

## 安全与复现约束

先用下面的存在性检查确认交互式 shell 能继承变量。该命令只输出 `PRESENT` 或 `MISSING`：

```zsh
zsh -ic 'if [[ -n ${EXPERIMENT_KEY:-} ]]; then print PRESENT; else print MISSING; fi'
```

结果为 `PRESENT`。所有 POST 请求均采用同一脱敏骨架：

```zsh
zsh -ic 'curl -sS -w "\nHTTP_STATUS=%{http_code}\n" \
  https://opencode.ai/zen/go/v1/<endpoint> \
  -H "Authorization: Bearer ${EXPERIMENT_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'"'"'JSON'"'"'
<payload shown below>
JSON'
```

用于循环汇总的响应体只曾短暂写入 PID 专属的 `/tmp/zen_*.$$`，读取后立即删除；密钥未写入这些文件。本探测任务在仓库内只新增本文档。

## 步骤与原始观察

### Step 1：模型发现与鉴权方式

请求：

```http
GET /zen/go/v1/models
Authorization: Bearer <EXPERIMENT_KEY>
```

结果：HTTP 200；返回 26 个模型，包含 `gpt-5.6-luna`。这只证明模型出现在目录中，不证明当前区域可调用。

鉴权对照：

- `Authorization: Bearer <EXPERIMENT_KEY>`：后续 `glm-5.1` 控制请求成功，证明该方式有效。
- `x-api-key: <EXPERIMENT_KEY>`：`POST /chat/completions` 返回 HTTP 401，`Missing API key.`。

### Step 2：Luna 普通 `/chat/completions`

请求字段：

```json
{
  "model": "gpt-5.6-luna",
  "messages": [
    {"role": "user", "content": "Reply with exactly ZEN_PLAIN_OK and nothing else."}
  ]
}
```

结果：HTTP 403。响应体结构为：

```json
{
  "id": "<dynamic-id>",
  "object": "chat.completion",
  "model": "gpt-5.6-luna",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant"},
      "finish_reason": null
    }
  ]
}
```

异常：响应没有 `message.content`、`tool_calls`、`usage` 或可读错误字段，却使用了 completion 外壳。Harness 必须先检查 HTTP 2xx，再检查有效终止载荷；不能因 `object == "chat.completion"` 就判成功。

### Step 3：核对模型专属接口

官方 Go 文档明确列出：

```text
GPT 5.6 Luna | gpt-5.6-luna | https://opencode.ai/zen/go/v1/responses | @ai-sdk/openai
```

据此发送正确格式的最小请求：

```json
{
  "model": "gpt-5.6-luna",
  "input": "Reply with exactly ZEN_RESPONSES_OK and nothing else."
}
```

结果：HTTP 403，明确错误为：

```json
{
  "model": "gpt-5.6-luna",
  "error": {
    "message": "Error from provider (Console Go): Upstream request failed: [403] This model is not available in your region."
  }
}
```

网络位置对照：`https://opencode.ai/cdn-cgi/trace` 返回 `loc=CN`、`colo=LAX`。这是一条运行环境可用性证据，不应解读成模型在所有中国网络或所有 LAX 接入点均不可用。

### Step 4：Luna 单函数调用

先按题设尝试 Chat Completions 工具格式：

```json
{
  "model": "gpt-5.6-luna",
  "messages": [
    {
      "role": "user",
      "content": "Call lookup_probe_value with key alpha. Do not answer directly."
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "lookup_probe_value",
        "description": "Look up a deterministic probe value",
        "parameters": {
          "type": "object",
          "properties": {"key": {"type": "string"}},
          "required": ["key"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": {
    "type": "function",
    "function": {"name": "lookup_probe_value"}
  }
}
```

结果：HTTP 400；仍返回空的 `chat.completion` 外壳，`finish_reason: null`，没有 `tool_calls` 或解释性错误。

随后按 Responses API 改写工具声明：

```json
{
  "model": "gpt-5.6-luna",
  "input": "Call lookup_probe_value with key alpha. Do not answer directly.",
  "tools": [
    {
      "type": "function",
      "name": "lookup_probe_value",
      "description": "Look up a deterministic probe value",
      "parameters": {
        "type": "object",
        "properties": {"key": {"type": "string"}},
        "required": ["key"],
        "additionalProperties": false
      }
    }
  ],
  "tool_choice": {"type": "function", "name": "lookup_probe_value"}
}
```

结果：HTTP 403，仍为相同的区域限制错误。没有产生真实 `call_id`，所以无法进行有证据效力的 Luna 工具结果续接。

### Step 5：Luna 工具结果续接负向探测

为了确认 Chat Completions 路由是否至少接受标准消息序列，使用假的本地 `tool_call_id` 构造：`user → assistant.tool_calls → tool → user`，并设置 `tool_choice: "none"`。这是协议接受性探测，不是假装完成真实工具闭环。

结果：HTTP 403；仍为空 completion 外壳，无最终内容与 `usage`。因为前一步没有真实模型生成的 tool call，此结果只说明该路径没有完成续接，不能用于判断模型语义能力。

### Step 6：`temperature` 与 `seed`

分别向 Luna `/chat/completions` 请求添加：

```json
{"temperature": 0}
```

```json
{"seed": 12345}
```

两者均返回 HTTP 403、空 completion 外壳、无 `usage`。为避免把“没有字段错误”误判成“字段受支持”，又加入未知字段控制：

```json
{"definitely_unknown_probe_field": "x"}
```

该请求也得到相同的 HTTP 403 与空外壳。因此 Luna `/chat/completions` 上不能推断 `temperature` 或 `seed` 是否被接受。

在官方 `/responses` 路由重复三种请求：`temperature: 0`、`seed: 12345`、未知字段。三者也都先命中相同的区域 403。由此只能断言区域检查遮蔽了字段能力，不能断言字段被接受、拒绝或执行。

### Step 7：`glm-5.1` 同环境控制组

选择官方明确映射到 `/chat/completions` 的 `glm-5.1`，保持 Bearer 密钥与网络不变。

| 探测 | HTTP | 关键结果 | `usage` |
| --- | ---: | --- | --- |
| 普通响应 | 200 | `content: "ZEN_CHAT_CONTROL_OK"`，`finish_reason: "stop"` | prompt 24 / completion 117 / total 141 |
| 强制单函数调用 | 200 | `finish_reason: "tool_calls"`；函数 `lookup_probe_value`；参数 `{"key":"alpha"}` | 174 / 57 / 231 |
| 注入 tool result 后续接 | 200 | `content: "PROBE_42"`，`finish_reason: "stop"` | 61 / 133 / 194 |
| `temperature: 0` | 200 | `content: "7"` | 19 / 63 / 82 |
| `seed: 12345` | 200 | `content: "7"` | 19 / 71 / 90 |
| 未知字段控制 | 400 | `Extra inputs are not permitted` | 无 |

工具续接使用的脱敏消息形状为：

```json
[
  {"role": "user", "content": "Call lookup_probe_value with key alpha."},
  {
    "role": "assistant",
    "content": "",
    "tool_calls": [
      {
        "id": "<tool-call-id>",
        "type": "function",
        "function": {
          "name": "lookup_probe_value",
          "arguments": "{\"key\":\"alpha\"}"
        }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "<tool-call-id>",
    "content": "{\"key\":\"alpha\",\"value\":\"PROBE_42\"}"
  },
  {"role": "user", "content": "Now reply with only the value returned by the tool."}
]
```

控制组还暴露了一个 Harness 风险：`max_tokens: 32` 与 `128` 两次请求只生成 `reasoning_content`，分别以 `finish_reason: "length"` 结束且 `content` 为空；提高到 `256` 后才得到最终文本。因此判断成功时必须同时检查 `finish_reason` 和可消费内容，预算也要涵盖隐藏/显式推理 Token。

## 能力判定矩阵

| 能力 | Luna `/chat/completions` | Luna `/responses` | 判定 |
| --- | --- | --- | --- |
| 普通响应 | 403，空 completion 外壳 | 403，明确区域错误 | `BLOCKED_BY_REGION`；Chat 路由不适配 |
| 单函数 tool call | 400，无 tool call | 403，明确区域错误 | `NOT_VERIFIED` |
| tool result continuation | 403，无内容；仅做伪 call-id 负测 | 无真实 call-id，未执行 | `NOT_VERIFIED` |
| `usage` | 不存在 | 错误响应不存在 | `NOT_VERIFIED` |
| `temperature` | 403，与未知字段不可区分 | 403，被区域检查遮蔽 | `INDETERMINATE` |
| `seed` | 403，与未知字段不可区分 | 403，被区域检查遮蔽 | `INDETERMINATE` |

## 异常与被推翻的解释

1. **“密钥没进子 shell”**：被交互式存在性检查及 `glm-5.1` HTTP 200 证伪。
2. **“Bearer 不是正确鉴权头”**：被控制组成功证伪；`x-api-key` 反而返回 401。
3. **“整个 Zen Go 服务不可用”**：被 `/models` 与 `glm-5.1` 成功证伪。
4. **“Luna 只是模型 ID 不存在”**：被 26 项模型目录和官方模型表证伪。
5. **“Luna 的空 completion 是成功”**：被非 2xx 状态、空内容、空终止原因和无 `usage` 证伪。
6. **“403 证明 sampling 字段有效”**：未知字段得到同类失败，无法区分，故该推断无效。

## 对 SkillScope 实验与插件的直接设计影响

1. Provider adapter 必须按模型选择传输协议；不能把 `baseURL + /chat/completions` 当成全局 OpenAI-compatible 契约。至少需要 `chat_completions`、`responses`、`messages` 三类 transport。
2. Pilot 默认模型若使用 `gpt-5.6-luna`，当前运行环境会系统性失败；应在正式实验前做一次小额 preflight，并把 `REGION_UNAVAILABLE` 与模型错误、鉴权错误、预算错误分开统计。
3. 在区域问题解除前，可用 `glm-5.1` 验证 Chat Completions Harness 的工具闭环，但这不能替代 Luna 的模型级兼容性验证。
4. 结果验证器必须要求：HTTP 2xx、非空 `choices/output`、合法 `finish_reason/status`；任务要求工具时还要验证真实 `tool_call/call_id`。JSON 外形本身不是成功证据。
5. `temperature`/`seed` 应作为运行时 capability probe 的结果，而不是静态假设。尤其 `seed` 即使语法接受，也不能仅凭一次 HTTP 200 宣称确定性。
6. 对返回 `finish_reason: "length"` 且只有 `reasoning_content` 的请求，应归类为预算耗尽而非有效答案，并保留真实 token usage。

## 解除阻断后的最小复验

需要从 Luna 可用区域重新运行以下顺序，才能完成原目标：

1. `POST /responses` 普通输入，要求 HTTP 200、有效 `output`/`status` 与 `usage`。
2. Responses API 单函数强制调用，保存服务端生成的 `call_id`。
3. 使用同一真实 `call_id` 注入 `function_call_output`，验证最终文本引用 `PROBE_42`。
4. 分别运行基线、`temperature: 0`、`seed: 12345`、未知字段；记录 HTTP、错误码与 usage。
5. 若 `seed` 被接受，至少做多次同 seed/异 seed 对照；否则只能报告“语法接受”，不能报告“可复现”。

复验不得通过未受信任的公开代理转发 Bearer 密钥，也不应绕过供应商区域策略。

---

# 追加实验：`deepseek-v4-flash` 主实验 Preflight

## 追加原因与判定标准

主实验模型改为额度更高的 `deepseek-v4-flash`。本节与 Luna 探测相互独立；仍从交互式 `zsh` 读取同一个 `EXPERIMENT_KEY`，未输出或落盘密钥。

Preflight 只有在以下条件全部成立时才算通过：

1. 官方声明的 transport 与实际成功路径一致；
2. 普通请求得到 HTTP 2xx、非空最终内容和 `finish_reason: stop`；
3. forced tool request 产生服务端真实 `tool_call.id`；
4. 用该真实 ID 提交 tool result 后，模型能消费结果并终止；
5. 两个成功响应都包含可解析的 `usage`；
6. `temperature` 与 `seed` 不仅得到 2xx，而且错误类型值会触发相应字段的类型错误；
7. 给出不会轻易截断推理、也不会无界放大单次运行的 `max_tokens` 建议。

最终判定：**PASS_WITH_CAVEATS**。模型和完整工具闭环可用于主实验；采样字段被类型化接受，但 `seed` 的确定性语义尚未证明，且该路由会静默接受未知顶层字段。

## DeepSeek 假设记录

| 编号 | 假设 | 证据要求 | 结果 |
| --- | --- | --- | --- |
| D1 | `deepseek-v4-flash` 使用 Chat Completions | 官方表和实际 2xx 一致 | **支持** |
| D2 | 可完成 forced tool call 与真实续接 | 真实 call ID、tool output 被最终答案引用 | **支持** |
| D3 | 成功响应提供 usage | 普通、tool call、续接均有 token 字段 | **支持** |
| D4 | `temperature`/`seed` 是被解析的字段 | 合法值 2xx，错误类型得到字段级 4xx | **支持语法与类型；效果未验证** |
| D5 | 未知顶层字段会被拒绝 | 未知字段得到 4xx | **证伪；未知字段被静默接受** |

## DS Step 1：Transport 与模型目录

[OpenCode Go 官方模型表](https://opencode.ai/docs/go#endpoints)列出：

```text
DeepSeek V4 Flash | deepseek-v4-flash | https://opencode.ai/zen/go/v1/chat/completions | @ai-sdk/openai-compatible
```

同日 `GET /zen/go/v1/models` 返回 HTTP 200、共 26 个模型，包含 `deepseek-v4-flash`。因此 runner 使用：

```text
POST https://opencode.ai/zen/go/v1/chat/completions
Authorization: Bearer <EXPERIMENT_KEY>
Content-Type: application/json
```

## DS Step 2：普通响应与 usage

请求字段：

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    {
      "role": "user",
      "content": "Reply with exactly DEEPSEEK_PREFLIGHT_OK and nothing else."
    }
  ],
  "max_tokens": 512
}
```

结果：HTTP 200，关键载荷为：

```json
{
  "model": "deepseek-v4-flash",
  "choices": [
    {
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "DEEPSEEK_PREFLIGHT_OK",
        "reasoning": "<provider reasoning omitted>",
        "tool_calls": null
      }
    }
  ],
  "usage": {
    "prompt_tokens": 99,
    "completion_tokens": 39,
    "total_tokens": 138,
    "prompt_tokens_details": {}
  },
  "cost": "0"
}
```

判定：普通响应、终止状态与 token usage 全部可用。`cost: "0"` 可能反映订阅结算，不能作为真实边际成本或免费调用证据。该模型使用 `message.reasoning` 字段，而先前 GLM 控制组使用 `reasoning_content`；runner 不应把任一供应商扩展字段当作最终内容。

## DS Step 3：Forced 单函数调用

请求字段：

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    {
      "role": "user",
      "content": "Call lookup_probe_value with key alpha. You must use the tool before answering."
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "lookup_probe_value",
        "description": "Look up a deterministic probe value",
        "parameters": {
          "type": "object",
          "properties": {"key": {"type": "string"}},
          "required": ["key"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": {
    "type": "function",
    "function": {"name": "lookup_probe_value"}
  },
  "max_tokens": 512
}
```

结果：HTTP 200；服务端实际返回：

```json
{
  "finish_reason": "tool_calls",
  "message": {
    "content": "",
    "tool_calls": [
      {
        "id": "<real-call-id>",
        "type": "function",
        "function": {
          "name": "lookup_probe_value",
          "arguments": "{\"key\": \"alpha\"}"
        }
      }
    ]
  },
  "usage": {
    "prompt_tokens": 381,
    "completion_tokens": 67,
    "total_tokens": 448,
    "prompt_tokens_details": {}
  }
}
```

判定：对象形式的 forced `tool_choice`、JSON Schema 中的 `additionalProperties: false`、字符串化函数参数和真实 call ID 均被支持。

## DS Step 4：真实 tool result continuation

下一请求直接使用 DS Step 3 由服务端生成的真实 call ID。文档中只将动态 ID 脱敏为 `<real-call-id>`：

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    {
      "role": "user",
      "content": "Call lookup_probe_value with key alpha. You must use the tool before answering."
    },
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [
        {
          "id": "<real-call-id>",
          "type": "function",
          "function": {
            "name": "lookup_probe_value",
            "arguments": "{\"key\": \"alpha\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "<real-call-id>",
      "content": "{\"key\":\"alpha\",\"value\":\"PROBE_42\"}"
    },
    {
      "role": "user",
      "content": "Reply with exactly the value returned by the tool and nothing else."
    }
  ],
  "tools": ["<same lookup_probe_value schema>"],
  "tool_choice": "none",
  "max_tokens": 512
}
```

结果：HTTP 200；最终 `content` 精确为 `PROBE_42`，`finish_reason` 为 `stop`。usage 为：

```json
{
  "prompt_tokens": 465,
  "completion_tokens": 81,
  "total_tokens": 546,
  "prompt_tokens_details": {"cached_tokens": 256}
}
```

这证明的是实际闭环而非伪造消息：call ID 来自上一响应，tool result 的 `PROBE_42` 被最终答案引用。续接请求没有回放供应商专有的 `message.reasoning`，仍然成功；runner 只需回放标准 assistant `tool_calls` 与 tool message，不需要存储或重新注入模型私有推理。

## DS Step 5：`max_tokens` 探测

用同一个短答案任务分别发送 `max_tokens` 为 64、128、512、2048：

| `max_tokens` | HTTP | `finish_reason` | 最终内容 | 实际 completion tokens |
| ---: | ---: | --- | --- | ---: |
| 64 | 200 | `stop` | `MAXTOK_OK` | 21 |
| 128 | 200 | `stop` | `MAXTOK_OK` | 19 |
| 512 | 200 | `stop` | `MAXTOK_OK` | 31 |
| 2048 | 200 | `stop` | `MAXTOK_OK` | 15 |

这些结果证明 64–2048 均是可接受的请求值，但短任务不能证明 64 足以覆盖主实验。官方 Go 页面给出的典型 DeepSeek V4 Flash 请求约有 310 个输出 Token；当前 forced tool call 与 continuation 分别用了 67 和 81 个 completion Token。

Runner 建议：

- 连通性 preflight：`max_tokens: 512`；
- 当前短答案访问边界任务：默认 `max_tokens: 1024`；
- 仅当响应以 `finish_reason: "length"` 结束时，对该次 Scope 以 `2048` 重试一次；
- 不把 2048 直接视为预期消耗，usage 按实际值记录；同时仍设置 Scope 总 token/tool-turn 预算。

## DS Step 6：`temperature` 与 `seed`

对同一短答案请求运行五个条件，均设置 `max_tokens: 128`：

| 条件 | HTTP | 结果 | usage（prompt / completion / total） |
| --- | ---: | --- | --- |
| 基线 | 200 | `7`, `stop` | 89 / 30 / 119 |
| `temperature: 0` | 200 | `7`, `stop` | 89 / 24 / 113 |
| `seed: 12345` | 200 | `7`, `stop` | 89 / 13 / 102 |
| 两者同时设置 | 200 | `7`, `stop` | 89 / 10 / 99 |
| 未知字段 | 200 | `7`, `stop` | 89 / 23 / 112 |

仅凭前四个 200 仍不能排除“字段被忽略”。因此增加错误类型探测：

```json
{"temperature": "not-a-number"}
```

返回 HTTP 400，错误明确要求 `temperature` 为 `f32`。

```json
{"seed": "not-an-integer"}
```

返回 HTTP 400，错误明确要求 `seed` 为 `u64`。

判定：当前 DeepSeek 路由确实解析并类型检查 `temperature` 与 `seed`，合法值可共同使用；但本轮没有证明固定 seed 能产生跨请求、跨时间或跨后端副本的字节级确定性。实验仍需保留重复运行和按任务聚类分析。

异常：`definitely_unknown_probe_field: "x"` 得到 HTTP 200，而非预期的 400。说明该路由会静默忽略至少一部分未知顶层字段。Runner 必须在本地维护请求字段 allowlist，不能依赖服务端发现拼写错误。

## DeepSeek Runner 推荐配置

建议的逻辑配置如下；鉴权值只从运行环境读取：

```json
{
  "baseURL": "https://opencode.ai/zen/go/v1",
  "transport": "chat_completions",
  "model": "deepseek-v4-flash",
  "apiKeyEnv": "EXPERIMENT_KEY",
  "temperature": 0,
  "seedPolicy": "same seed for the same task × repetition across compared conditions",
  "maxTokens": 1024,
  "lengthRetryMaxTokens": 2048,
  "requestTimeoutMs": 60000,
  "maxToolTurns": 8
}
```

实现约束：

1. 将 `seed` 设为可复现的无符号整数，例如由 `taskId + repetition` 稳定派生；同一配对比较使用同一 seed，但不要把它当作独立样本或确定性保证。
2. 每次请求都记录 HTTP 状态、`finish_reason`、prompt/completion/total/cached tokens、tool call 数与延迟。
3. 接受最终结果前要求 HTTP 2xx，且必须恰有一种有效动作：非空 `message.content` 或非空 `message.tool_calls`。
4. 工具调用时解析 `function.arguments` JSON，校验本地 Schema，并把服务端真实 `tool_call.id` 原样用于 `role: tool` 消息。
5. 不回放 `message.reasoning`，不把它当作最终答案，也不依赖它计算独立 token 成本；以服务端 `usage` 为准。
6. 只对 429、可恢复 5xx 和网络超时做带抖动退避；400 等请求错误直接分类，不盲目重试。
7. 本地拒绝未知请求字段，因为服务端可能静默忽略拼写错误。

## DeepSeek Preflight 最终能力矩阵

| 能力 | 结果 | 状态 |
| --- | --- | --- |
| 官方 transport | `/chat/completions` 与实测一致 | `PASS` |
| 普通响应 | 200，精确内容，`stop` | `PASS` |
| forced function call | 200，真实 call ID 与合法 arguments | `PASS` |
| tool result continuation | 200，最终精确引用 `PROBE_42` | `PASS` |
| usage | 三类成功响应均完整返回 | `PASS` |
| `max_tokens` | 64/128/512/2048 均接受；runner 默认 1024 | `PASS` |
| `temperature` | 合法 f32 值 200，错误类型 400 | `PASS` |
| `seed` | 合法 u64 值 200，错误类型 400 | `PASS`（确定性未证明） |
| 未知字段拒绝 | 未知字段被静默接受 | `FAIL`，由本地校验补偿 |

综合结论：`deepseek-v4-flash` 可以作为当前 SkillScope 主实验模型。该结论覆盖 transport、单轮响应、真实工具闭环和 usage 计量；不扩张为“seed 保证确定性”或“服务端会替客户端校验所有字段”。
