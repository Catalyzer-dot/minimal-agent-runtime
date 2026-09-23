import { z } from 'zod';
import {
  Agent,
  run,
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type RunEvent,
} from '../src/index.ts';

const calculator = tool({
  name: 'calculator',
  description: 'Add two numbers.',
  parameters: z.object({
    left: z.number(),
    right: z.number(),
  }),
  timeoutMs: 1_000,
  execute: ({ left, right }) => ({ result: left + right }),
});

class ScriptedModel implements Model {
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const toolResult = [...request.input]
      .reverse()
      .find((item) => item.type === 'tool_result');

    if (!toolResult || toolResult.type !== 'tool_result') {
      return {
        output: [
          {
            type: 'tool_call',
            callId: 'call_1',
            name: 'calculator',
            arguments: JSON.stringify({ left: 16, right: 6 }),
          },
        ],
      };
    }

    return {
      output: [
        {
          type: 'assistant_message',
          content: `计算结果是 ${JSON.parse(toolResult.output).result}。`,
        },
      ],
    };
  }
}

const agent = new Agent({
  name: 'Calculator Agent',
  instructions: 'Use the calculator tool to answer arithmetic questions.',
  model: new ScriptedModel(),
  tools: [calculator],
});

const events: RunEvent[] = [];
const result = await run(agent, '请计算 16 + 6。', {
  onEvent: (event) => events.push(event),
});

console.log('最终答案:', result.finalOutput);
console.log('模型调用轮数:', result.turns);
console.log('运行事件:', JSON.stringify(events, null, 2));
console.log('完整历史:', JSON.stringify(result.history, null, 2));
