import { z } from 'zod';
import {
  Agent,
  DeepSeekModel,
  run,
  tool,
  type RunEvent,
} from '../src/index.ts';

const calculator = tool({
  name: 'calculator',
  description: 'Calculate the sum of two numbers.',
  parameters: z.object({
    left: z.number(),
    right: z.number(),
  }),
  timeoutMs: 3_000,
  execute: ({ left, right }) => ({ result: left + right }),
});

const events: RunEvent[] = [];
const result = await run(
  new Agent({
    name: 'DeepSeek Calculator',
    instructions:
      'You are a calculator assistant. Use the calculator tool for arithmetic, then explain the result briefly in Chinese.',
    model: new DeepSeekModel(),
    tools: [calculator],
  }),
  process.argv.slice(2).join(' ') || '请计算 16 + 6。',
  { onEvent: (event) => events.push(event) },
);

console.log('最终答案:', result.finalOutput);
console.log('模型调用轮数:', result.turns);
console.log('运行事件:', JSON.stringify(events, null, 2));
