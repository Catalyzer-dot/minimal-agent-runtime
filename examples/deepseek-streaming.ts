import { z } from 'zod';
import { Agent, DeepSeekModel, Runner, tool } from '../src/index.ts';

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

const agent = new Agent({
  name: 'Streaming DeepSeek Calculator',
  instructions:
    'You are a calculator assistant. Use the calculator tool for arithmetic, then explain the result briefly in Chinese.',
  model: new DeepSeekModel(),
  tools: [calculator],
});

const input = process.argv.slice(2).join(' ') || '请计算 16 + 6。';
const stream = new Runner().runStream(agent, input);

console.log('用户输入:', input);
console.log('开始流式运行：');

let printedText = false;
while (true) {
  const next = await stream.next();
  if (next.done) {
    if (printedText) process.stdout.write('\n');
    console.log('\n最终答案:', next.value.finalOutput);
    console.log('模型调用轮数:', next.value.turns);
    break;
  }

  const event = next.value;
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta);
      printedText = true;
      break;
    case 'tool_call_delta':
      console.log(
        '\n[tool_call_delta]',
        JSON.stringify({
          turn: event.turn,
          index: event.index,
          callId: event.callId,
          name: event.name,
          argumentsDelta: event.argumentsDelta,
        }),
      );
      break;
    case 'tool_started':
      console.log(`\n[tool_started] ${event.toolName} (${event.callId})`);
      break;
    case 'tool_completed':
      console.log(`[tool_completed] ${event.output}`);
      break;
    case 'tool_failed':
      console.log(`[tool_failed] ${event.error}`);
      break;
    case 'tool_timed_out':
      console.log(`[tool_timed_out] ${event.timeoutMs}ms`);
      break;
    case 'tool_cancelled':
      console.log(`[tool_cancelled] ${event.reason}`);
      break;
  }
}
