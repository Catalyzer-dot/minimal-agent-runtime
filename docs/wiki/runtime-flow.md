# Minimal Agent Runtime 运行流程

本文描述当前 `minimal-agent-runtime` 的模块职责、Agent Loop、工具调用、超时、取消和事件流。

## 1. 模块架构

```mermaid
flowchart LR
    App[业务代码] --> Agent[Agent<br/>模型、指令、工具配置]
    App --> API[run]
    API --> Runner[Runner<br/>Agent Loop 与运行策略]
    Runner --> Agent
    Runner --> Model[Model<br/>生成消息或 Tool Call]
    Runner --> Tool[FunctionTool<br/>Schema、invoke、execute]
    Runner --> Events[RunEvent<br/>生命周期事件]
    Runner --> Result[RunResult<br/>答案、历史、原始响应、轮数]

    Tool --> Zod[Zod<br/>参数校验]
    Tool --> Business[业务 execute]
    Model --> Provider[ScriptedModel<br/>未来可替换真实 Provider]
```

模块边界：

| 模块 | 负责 | 不负责 |
|---|---|---|
| `Agent` | 保存模型、指令和工具 | 不执行循环和工具 |
| `Model` | 根据请求返回消息或 Tool Call | 不直接执行工具 |
| `FunctionTool` | 描述工具、校验参数、调用业务函数 | 不决定何时再次调用模型 |
| `Runner` | 驱动循环、执行工具、应用超时策略、维护历史 | 不实现具体业务能力 |
| `RunEvent` | 暴露可观测的语义事件 | 不承载隐藏推理过程 |
| `RunResult` | 汇总最终输出和运行记录 | 不继续驱动循环 |

## 2. 完整 Agent Loop

```mermaid
flowchart TD
    Start([用户输入]) --> Init[创建 history<br/>写入 UserMessage]
    Init --> Turn{是否还有剩余 Turn}

    Turn -- 否 --> MaxError[抛出 MaxTurnsExceededError]
    Turn -- 是 --> Request[构造 ModelRequest<br/>instructions、history、tools、signal]
    Request --> ModelCall[调用 Model.getResponse]
    ModelCall --> Record[记录 rawResponses<br/>追加 ModelOutput 到 history]
    Record --> HasTool{响应包含 Tool Call?}

    HasTool -- 否 --> HasMessage{存在 AssistantMessage?}
    HasMessage -- 否 --> BehaviorError[抛出 ModelBehaviorError]
    HasMessage -- 是 --> Final[创建 RunResult]
    Final --> End([返回 finalOutput])

    HasTool -- 是 --> Lookup[按 name 查找 FunctionTool]
    Lookup --> Found{找到工具?}
    Found -- 否 --> Unknown[抛出 ModelBehaviorError]
    Found -- 是 --> Started[发出 tool_started]
    Started --> Invoke[invokeFunctionTool]
    Invoke --> Parse[JSON.parse arguments]
    Parse --> Validate[Zod Schema 校验]
    Validate --> Execute[execute parameters 与 signal]
    Execute --> Outcome{执行结果}

    Outcome -- 成功 --> Completed[发出 tool_completed]
    Completed --> SuccessResult[写入成功 ToolResult]

    Outcome -- 普通异常 --> Failed[发出 tool_failed]
    Failed --> ErrorResult[写入错误 ToolResult]

    Outcome -- 超时 --> TimedOut[发出 tool_timed_out]
    TimedOut --> TimeoutPolicy{timeoutBehavior}
    TimeoutPolicy -- error_as_result --> ErrorResult
    TimeoutPolicy -- raise_exception --> TimeoutError[抛出 ToolTimeoutError]

    Outcome -- 外部取消 --> Cancelled[发出 tool_cancelled]
    Cancelled --> CancelError[终止 Run]

    SuccessResult --> Next[进入下一 Turn]
    ErrorResult --> Next
    Next --> Turn
```

关键停止条件：

- 没有 Tool Call 且存在 AssistantMessage：正常结束。
- 超过 `maxTurns`：抛出 `MaxTurnsExceededError`。
- 模型请求未注册工具：抛出 `ModelBehaviorError`。
- Tool 超时且策略为 `raise_exception`：抛出 `ToolTimeoutError`。
- 外部 `AbortSignal` 取消：终止本次 Run。

## 3. 正常 Tool Calling 时序

```mermaid
sequenceDiagram
    actor User as 用户
    participant App as 业务代码
    participant Runner
    participant Model
    participant Tool as FunctionTool
    participant Execute as execute

    User->>App: 请计算 16 + 6
    App->>Runner: run(agent, input)
    Runner->>Model: getResponse(ModelRequest)
    Model-->>Runner: ToolCall(call_1, calculator, arguments)
    Runner->>Runner: 记录 ToolCall
    Runner->>App: tool_started
    Runner->>Tool: invokeFunctionTool(call_1)
    Tool->>Tool: JSON.parse + Zod 校验
    Tool->>Execute: execute({ left: 16, right: 6 }, { signal })
    Execute-->>Tool: { result: 22 }
    Tool-->>Runner: JSON 字符串结果
    Runner->>Runner: 写入 ToolResult(call_1)
    Runner->>App: tool_completed
    Runner->>Model: getResponse(包含 ToolCall 与 ToolResult 的 history)
    Model-->>Runner: AssistantMessage(计算结果是 22)
    Runner-->>App: RunResult.finalOutput
    App-->>User: 计算结果是 22
```

`callId` 用于关联一次具体调用与结果：

```text
ToolCall.callId == ToolResult.callId
```

同一轮多次调用相同工具时，不能只依赖工具名匹配结果。

## 4. 超时与取消流程

```mermaid
flowchart TD
    Runner[Runner] --> StartEvent[tool_started]
    StartEvent --> Wrapper[invokeFunctionTool]
    Wrapper --> Controller[创建 AbortController]
    Wrapper --> Timer[启动 timeoutMs 计时器]
    Wrapper --> Parent[监听 RunOptions.signal]
    Wrapper --> Invoke[Tool.invoke]
    Invoke --> Execute[execute parameters 与 signal]

    Execute --> Fast{在期限内完成?}
    Fast -- 是 --> Cleanup[清理计时器和监听器]
    Cleanup --> CompleteEvent[tool_completed]

    Fast -- 否，工具超时 --> Timeout[ToolTimeoutError]
    Timeout --> AbortTool[abort Tool signal]
    AbortTool --> CleanupTimeout[清理计时器和监听器]
    CleanupTimeout --> TimeoutEvent[tool_timed_out]
    TimeoutEvent --> Policy{timeoutBehavior}
    Policy -- error_as_result --> Recover[错误 ToolResult 回填模型]
    Policy -- raise_exception --> Stop[终止 Run]

    Parent -- 外部取消 --> AbortRun[abort Tool signal]
    AbortRun --> CancelEvent[tool_cancelled]
    CancelEvent --> Stop
```

注意：

> `Promise.race()` 只能让 Runtime 停止等待。业务 `execute()` 及其调用的 HTTP、数据库客户端必须响应 `AbortSignal`，底层任务才会真正停止。

## 5. 错误处理矩阵

| 场景 | 事件 | History | Run 是否继续 |
|---|---|---|---|
| Tool 正常完成 | `tool_started` → `tool_completed` | 成功 `ToolResult` | 是 |
| JSON、Zod 或业务异常 | `tool_started` → `tool_failed` | 错误 `ToolResult` | 是，模型可修正 |
| Tool 超时，`error_as_result` | `tool_started` → `tool_timed_out` | 错误 `ToolResult` | 是 |
| Tool 超时，`raise_exception` | `tool_started` → `tool_timed_out` | 不写超时结果 | 否 |
| 外部取消 | `tool_started` → `tool_cancelled` | 不写取消结果 | 否 |
| Tool 未注册 | 无 Tool 事件 | 已记录模型的 `ToolCall` | 否 |
| 超过最大轮数 | 之前的历史保留 | 保留已执行记录 | 否 |

## 6. 状态数据流

```mermaid
flowchart LR
    Input[用户输入] --> History[history]
    ModelResponse[ModelResponse.output] --> History
    ToolOutput[ToolResult] --> History
    History --> NextRequest[下一轮 ModelRequest.input]

    ModelResponse --> Raw[rawResponses]
    History --> Result[RunResult]
    Raw --> Result
    Turns[turns] --> Result
    Final[finalOutput] --> Result
```

- `history`：标准化运行状态，用于下一轮输入、恢复和重放。
- `rawResponses`：保存每轮原始模型响应，用于追踪和故障定位。
- `RunEvent`：实时通知运行阶段，不替代持久化状态。
- `RunResult`：运行结束后的汇总结果。

## 7. 代码导航

| 阅读顺序 | 文件 | 关注点 |
|---|---|---|
| 1 | `examples/calculator.ts` | SDK 使用者如何定义 Tool、Agent 和事件监听 |
| 2 | `src/model.ts` | 模型请求、响应和 History 协议 |
| 3 | `src/tool.ts` | Schema、`invoke()`、超时和取消机制 |
| 4 | `src/agent.ts` | Agent 配置边界 |
| 5 | `src/runner.ts` | Agent Loop、错误策略和事件分发 |
| 6 | `src/events.ts` | 生命周期事件类型 |
| 7 | `src/result.ts` | 最终结果结构 |
| 8 | `tests/tool.test.ts` | Tool 单元测试 |
| 9 | `tests/runner.test.ts` | Runtime 集成测试 |
| 10 | `src/deepseek-model.ts` | DeepSeek Chat Completions 与内部协议的适配 |
| 11 | `examples/deepseek-calculator.ts` | 真实模型的 Tool Calling 示例 |

## 8. DeepSeek Provider 映射

```mermaid
sequenceDiagram
    participant Runner
    participant DS as DeepSeekModel
    participant API as DeepSeek Chat Completions

    Runner->>DS: ModelRequest
    DS->>DS: history → messages
    DS->>DS: tools → function definitions
    DS->>API: POST /chat/completions
    API-->>DS: assistant content 或 tool_calls
    DS->>DS: tool_calls → 内部 ToolCall
    DS-->>Runner: ModelResponse
```

关键协议映射：

| 内部协议 | DeepSeek Chat Completions |
|---|---|
| `instructions` | `messages` 中的 `system` |
| `UserMessage` | `role: user` |
| `AssistantMessage` | `role: assistant` |
| `ToolCall` | `assistant.tool_calls[]` |
| `ToolResult` | `role: tool` + `tool_call_id` |
| `FunctionTool` | `tools[].type = function` |

API Key 只从 `DEEPSEEK_API_KEY` 环境变量或构造参数读取，不进入 `RunResult`、事件或错误信息。

## 9. 流式执行

当前已实现最小流式 Provider 和 Runner：

```mermaid
sequenceDiagram
    participant Runner
    participant DS as DeepSeekModel
    participant API as DeepSeek SSE
    Runner->>DS: getResponseStream(ModelRequest)
    DS->>API: POST stream=true
    API-->>DS: text delta / tool_call delta
    DS-->>Runner: text_delta / tool_call_delta
    API-->>DS: [DONE]
    DS-->>Runner: completed(ModelResponse)
    Runner->>Runner: 完整参数后才校验并执行 Tool
```

文本可以立即增量展示；Tool Call 的 name 和 arguments 必须在 Provider 层聚合完成，
再由 Runner 进入和非流式相同的 Schema 校验、超时、取消和错误处理流程。

## 10. 当前未实现

```text
Guardrails 与人工审批
Handoffs 与 Agent as Tool
Session、持久化与中断恢复
Tracing 与 Usage
MCP、Hosted Tools、Realtime 与 Sandbox
完整生产级 Streaming reconciliation、Usage 和 Trace
```

这些能力应在当前 Agent Loop、超时、取消和事件流完全理解后逐层加入。
