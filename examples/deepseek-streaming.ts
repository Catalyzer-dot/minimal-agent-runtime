import { z } from 'zod';
import { Agent, DeepSeekModel, Runner, tool } from '../src/index.ts';

const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const calculator = tool({
  name: 'calculator',
  description: 'Calculate the sum of two numbers.',
  parameters: z.object({
    left: z.number(),
    right: z.number(),
  }),
  timeoutMs: 3_000,
  execute: async ({ left, right }, {signal}) => {
    await sleep(4000, signal);
    return { result: left + right }
  }
  ,
});

const agent = new Agent({
  name: 'Streaming DeepSeek Calculator',
  instructions:
    'You are a calculator assistant. Use the calculator tool for arithmetic, then explain the result briefly in Chinese.',
  model: new DeepSeekModel(),
  tools: [calculator],
});

const input = process.argv.slice(2).join(' ') || '请计算 16 + 6。';
const stream = new Runner().stream(agent, input);

console.log('用户输入:', input);
console.log('开始流式运行：');

let printedText = false;
for await (const event of stream) {
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

const result = await stream.completed;
if (printedText) process.stdout.write('\n');
console.log('\n最终答案:', result.finalOutput);
console.log('模型调用轮数:', result.turns);
