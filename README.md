# Minimal Agent Runtime

这是一个用于源码学习的最小 TypeScript Agent Runtime。它参考 `openai-agents-js` 的职责划分，但只保留最核心的 Function Tool 闭环。

## 架构

```text
Agent：保存模型、指令和工具配置
Model：定义模型请求与响应协议
Tool：把 Zod Schema、描述和真实函数包装成 Function Tool
Runner：维护历史并驱动 Agent Loop
RunResult：暴露最终答案、历史、原始响应和轮数
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

## 推荐阅读顺序

1. `examples/calculator.ts`
2. `src/model.ts`
3. `src/tool.ts`
4. `src/agent.ts`
5. `src/runner.ts`
6. `src/result.ts`
7. `tests/runner.test.ts`

## 暂未实现

- Streaming
- Guardrails 和人工审批
- Handoffs 和 Agent as Tool
- Session、持久化和中断恢复
- Tracing、Usage 和生命周期事件
- MCP、Hosted Tools、Realtime 和 Sandbox
- 真实 OpenAI Provider 适配器

这些功能会在掌握最小循环后逐层加入，不应一次堆进基础版本。
