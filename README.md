# Minimal Agent Runtime

这是一个用于源码学习的最小 TypeScript Agent Runtime。它参考 `openai-agents-js` 的职责划分，但只保留最核心的 Function Tool 闭环。

## 架构

```text
Agent：保存模型、指令和工具配置
Model：定义模型请求与响应协议
Tool：把 Zod Schema、描述和真实函数包装成 Function Tool
Runner：维护历史并驱动 Agent Loop
RunResult：暴露最终答案、历史、原始响应和轮数
Events：暴露文本增量、Tool Call 增量和工具生命周期事件
```

运行过程：

```text
用户输入
→ Runner 调用 Model
→ Model 返回 Tool Call
→ Runner 查找并调用 Tool
→ Tool 解析 JSON、执行 Zod 校验、调用 execute
→ Runner 把 Tool Result 写回历史
→ Runner 再次调用 Model
→ Model 返回普通消息
→ Runner 返回 RunResult
```

## 运行

```bash
pnpm install
pnpm demo
pnpm test
pnpm typecheck
```

示例使用确定性的 `ScriptedModel`，不需要 API Key。它不是模拟模型智能，而是让你能够单独观察 Runtime 如何处理模型响应。

## 超时、取消和事件

Tool 负责声明自己的策略：

```ts
const searchTool = tool({
  name: 'search',
  description: 'Search documents.',
  parameters: z.object({ query: z.string() }),
  timeoutMs: 3_000,
  timeoutBehavior: 'error_as_result',
  execute: async ({ query }, { signal }) => {
    return await search(query, { signal });
  },
});
```

Runner 负责统一执行并处理策略：

- `error_as_result`：把 `ToolTimeoutError` 转成错误 Tool Result，模型可以继续处理。
- `raise_exception`：抛出 `ToolTimeoutError`，立即终止本次运行。
- `RunOptions.signal`：取消整个运行，并传递到正在执行的 Tool。
- `RunOptions.onEvent`：接收 `tool_started`、`tool_completed`、`tool_failed`、`tool_timed_out` 和 `tool_cancelled`。

Runner 还支持运行时预算和循环防护：

```ts
await run(agent, input, {
  maxTurns: 10,
  limits: {
    maxToolCalls: 20,
    maxRunDurationMs: 60_000,
    maxRepeatedToolCalls: 3,
  },
});
```

其中 `maxRepeatedToolCalls` 根据 `toolName + arguments` 识别完全相同的重复调用，
触发后抛出 `RunLimitExceededError` 并发出 `run_limit_exceeded`。这是运行时护栏，
不能替代工具本身的幂等键、状态查询、补偿操作和人工接管。

运行事件还包括 `run_started`、`model_started`、`model_completed`、`run_completed`，
其中模型和工具完成事件带有 `durationMs`，可用于构建基础耗时和错误监控。

`invokeFunctionTool()` 是底层执行机制，遇到超时总是抛出 `ToolTimeoutError`；超时策略由上层 Runner 应用。这种拆分用于展示“机制”和“策略”的边界。

## 接入真实 DeepSeek

项目包含 [DeepSeekModel](./src/deepseek-model.ts)，它通过原生 `fetch` 调用 DeepSeek Chat Completions，并将 DeepSeek 的 `tool_calls` 映射为内部 `ToolCall`。

可以将 Key 写入项目根目录的 `.env`：

```bash
# .env
DEEPSEEK_API_KEY=你的 API Key

pnpm demo:deepseek
```

流式版本：

```bash
pnpm demo:deepseek:stream "请计算 16 + 6，并说明过程"
```

`demo:deepseek` 使用 Node 原生 `--env-file-if-exists=.env` 加载配置。也可以通过 shell、IDE Run Configuration 或进程管理器注入环境变量。不要把 Key 写进源码、命令历史或日志。

请求的关键映射：

```text
ModelRequest.instructions → messages[0].role = system
ModelRequest.input        → user / assistant / tool messages
ModelRequest.tools        → tools[].function
DeepSeek tool_calls       → 内部 ToolCall(callId, name, arguments)
内部 ToolResult           → role = tool, tool_call_id = callId
```

真实调用会产生 API 费用，并依赖网络和账户权限；单元测试使用 mock `fetch`，不会访问 DeepSeek。

## 流式运行

`DeepSeekModel` 同时实现了 `getResponseStream()`。Runner 提供 `stream()`，它返回一个
`StreamedRunResult`，可以同时观察模型文本和 Tool Call 参数的增量，并等待最终结果：

```ts
const stream = new Runner().stream(agent, '请计算 16 + 6。');
for await (const event of stream) {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
  if (event.type === 'tool_call_delta') {
    console.log('Tool 参数仍在累积中:', event.argumentsDelta ?? '');
  }
}

const finalResult = await stream.completed;
console.log(finalResult.finalOutput);
```

流式事件只负责观测。Runner 必须等 Provider 发出 `completed`，得到完整的
`ToolCall.arguments` 后，才会执行 Tool；因此不会因为某个参数片段到达就产生副作用。
如果 Model 没有实现流式接口，底层 `runStream()` 会退化为一次非流式调用并发出一个完整文本事件。

## 推荐阅读顺序

1. `examples/calculator.ts`
2. `src/model.ts`
3. `src/tool.ts`
4. `src/agent.ts`
5. `src/runner.ts`
6. `src/events.ts`
7. `src/result.ts`
8. `tests/tool.test.ts`
9. `tests/runner.test.ts`
10. `src/deepseek-model.ts`
11. `examples/deepseek-calculator.ts`
12. `tests/deepseek-model.test.ts` 中的 SSE 聚合测试

## 暂未实现

- Guardrails 和人工审批
- Handoffs 和 Agent as Tool
- Session、持久化和中断恢复
- Tracing 和 Usage
- MCP、Hosted Tools、Realtime 和 Sandbox
- 目前的流式实现仍是最小版本，尚未包含完整 SDK 的 usage、trace reconciliation、音频和多模态事件。

这些功能会在掌握最小循环后逐层加入，不应一次堆进基础版本。

## Wiki

- [项目运行流程图](./docs/wiki/runtime-flow.md)
