import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  Agent,
  MaxTurnsExceededError,
  ModelBehaviorError,
  run,
  Runner,
  tool,
  ToolTimeoutError,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type RunEvent,
} from '../src/index.ts';

const echoTool = tool({
  name: 'echo',
  description: 'Echo a message.',
  parameters: z.object({ message: z.string() }),
  execute: ({ message }) => message,
});

test('executes a tool and gives its result back to the model', async () => {
  const requests: ModelRequest[] = [];
  const events: RunEvent[] = [];
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      requests.push(request);
      const result = [...request.input]
        .reverse()
        .find((item) => item.type === 'tool_result');

      if (!result || result.type !== 'tool_result') {
        return {
          output: [
            {
              type: 'tool_call',
              callId: 'call_1',
              name: 'echo',
              arguments: JSON.stringify({ message: 'hello' }),
            },
          ],
        };
      }

      return {
        output: [{ type: 'assistant_message', content: result.output }],
      };
    },
  };

  const result = await run(
    new Agent({
      name: 'Echo Agent',
      instructions: 'Use echo.',
      model,
      tools: [echoTool],
    }),
    'Say hello.',
    { onEvent: (event) => events.push(event) },
  );

  assert.equal(result.finalOutput, 'hello');
  assert.equal(result.turns, 2);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].input.some((item) => item.type === 'tool_result'),
    true,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool_started', 'tool_completed'],
  );
});

test('runStream emits deltas and executes tools only after completion', async () => {
  const events: RunEvent[] = [];
  let calls = 0;
  const model: Model = {
    async getResponse(): Promise<ModelResponse> {
      return { output: [{ type: 'assistant_message', content: 'unused' }] };
    },
    async *getResponseStream(request) {
      const result = [...request.input].reverse().find((item) => item.type === 'tool_result');
      if (result) {
        yield { type: 'text_delta', delta: result.output };
        yield { type: 'completed', response: { output: [{ type: 'assistant_message', content: result.output }] } };
      } else {
        yield { type: 'tool_call_delta', index: 0, callId: 'stream_call', name: 'echo', argumentsDelta: '{"message":"streamed"}' };
        yield { type: 'completed', response: { output: [{ type: 'tool_call', callId: 'stream_call', name: 'echo', arguments: '{"message":"streamed"}' }] } };
      }
    },
  };
  const runner = new Runner();
  const stream = runner.runStream(new Agent({ name: 'Stream Agent', instructions: 'Use echo.', model, tools: [tool({ name: 'echo', description: 'Echo.', parameters: z.object({ message: z.string() }), execute: ({ message }) => { calls += 1; return message; } })] }), 'Start.');
  for await (const event of stream) events.push(event);
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ['tool_call_delta', 'tool_started', 'tool_completed', 'text_delta']);
});

test('returns tool validation errors to the model', async () => {
  const events: RunEvent[] = [];
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      const result = [...request.input]
        .reverse()
        .find((item) => item.type === 'tool_result');

      if (!result || result.type !== 'tool_result') {
        return {
          output: [
            {
              type: 'tool_call',
              callId: 'call_1',
              name: 'echo',
              arguments: JSON.stringify({ message: 123 }),
            },
          ],
        };
      }

      return {
        output: [
          {
            type: 'assistant_message',
            content: result.isError ? '参数错误已处理' : 'unexpected',
          },
        ],
      };
    },
  };

  const result = await run(
    new Agent({
      name: 'Recovery Agent',
      instructions: 'Handle errors.',
      model,
      tools: [echoTool],
    }),
    'Echo a number.',
    { onEvent: (event) => events.push(event) },
  );

  assert.equal(result.finalOutput, '参数错误已处理');
  assert.equal(
    result.history.some(
      (item) => item.type === 'tool_result' && item.isError,
    ),
    true,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool_started', 'tool_failed'],
  );
});

test('throws when the model requests an unknown tool', async () => {
  const model: Model = {
    async getResponse(): Promise<ModelResponse> {
      return {
        output: [
          {
            type: 'tool_call',
            callId: 'call_1',
            name: 'missing_tool',
            arguments: '{}',
          },
        ],
      };
    },
  };

  await assert.rejects(
    run(
      new Agent({
        name: 'Broken Agent',
        instructions: 'Call a missing tool.',
        model,
      }),
      'Start.',
    ),
    ModelBehaviorError,
  );
});

test('stops a tool loop at maxTurns', async () => {
  let callId = 0;
  const loopingModel: Model = {
    async getResponse(): Promise<ModelResponse> {
      callId += 1;
      return {
        output: [
          {
            type: 'tool_call',
            callId: `call_${callId}`,
            name: 'echo',
            arguments: JSON.stringify({ message: 'again' }),
          },
        ],
      };
    },
  };

  await assert.rejects(
    run(
      new Agent({
        name: 'Looping Agent',
        instructions: 'Keep calling a tool.',
        model: loopingModel,
        tools: [echoTool],
      }),
      'Start.',
      { maxTurns: 2 },
    ),
    MaxTurnsExceededError,
  );
  assert.equal(callId, 2);
});

test('returns a timeout to the model when behavior is error_as_result', async () => {
  const events: RunEvent[] = [];
  const slowTool = tool({
    name: 'slow_tool',
    description: 'Wait forever.',
    parameters: z.object({}),
    timeoutMs: 5,
    execute: async (_, { signal }) => {
      await waitForAbort(signal);
      return 'unreachable';
    },
  });

  const result = await run(
    new Agent({
      name: 'Timeout Recovery Agent',
      instructions: 'Handle a tool timeout.',
      model: createToolCallingModel('slow_tool', '超时错误已处理'),
      tools: [slowTool],
    }),
    'Start.',
    { onEvent: (event) => events.push(event) },
  );

  assert.equal(result.finalOutput, '超时错误已处理');
  assert.equal(
    result.history.some(
      (item) => item.type === 'tool_result' && item.isError,
    ),
    true,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool_started', 'tool_timed_out'],
  );
});

test('throws a timeout when behavior is raise_exception', async () => {
  let receivedAbort = false;
  const strictTimeoutTool = tool({
    name: 'strict_timeout',
    description: 'Fail the run on timeout.',
    parameters: z.object({}),
    timeoutMs: 5,
    timeoutBehavior: 'raise_exception',
    execute: async (_, { signal }) => {
      try {
        await waitForAbort(signal);
      } finally {
        receivedAbort = signal.aborted;
      }
      return 'unreachable';
    },
  });

  await assert.rejects(
    run(
      new Agent({
        name: 'Strict Timeout Agent',
        instructions: 'Fail on timeout.',
        model: createToolCallingModel('strict_timeout', 'unreachable'),
        tools: [strictTimeoutTool],
      }),
      'Start.',
    ),
    ToolTimeoutError,
  );
  assert.equal(receivedAbort, true);
});

test('cancels a running tool when the run signal is aborted', async () => {
  const controller = new AbortController();
  const events: RunEvent[] = [];
  let receivedAbort = false;
  const cancellableTool = tool({
    name: 'cancellable_tool',
    description: 'Wait until cancelled.',
    parameters: z.object({}),
    execute: async (_, { signal }) => {
      try {
        await waitForAbort(signal);
      } finally {
        receivedAbort = signal.aborted;
      }
      return 'unreachable';
    },
  });

  const runPromise = run(
    new Agent({
      name: 'Cancellable Agent',
      instructions: 'Call the cancellable tool.',
      model: createToolCallingModel('cancellable_tool', 'unreachable'),
      tools: [cancellableTool],
    }),
    'Start.',
    {
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'tool_started') {
          setTimeout(() => {
            controller.abort(new Error('Cancelled by user.'));
          }, 0);
        }
      },
    },
  );

  await assert.rejects(runPromise, /Cancelled by user/);
  assert.equal(receivedAbort, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool_started', 'tool_cancelled'],
  );
});

function createToolCallingModel(
  toolName: string,
  finalMessage: string,
): Model {
  return {
    async getResponse(request): Promise<ModelResponse> {
      const toolResult = [...request.input]
        .reverse()
        .find((item) => item.type === 'tool_result');

      if (!toolResult) {
        return {
          output: [
            {
              type: 'tool_call',
              callId: 'call_1',
              name: toolName,
              arguments: '{}',
            },
          ],
        };
      }

      return {
        output: [{ type: 'assistant_message', content: finalMessage }],
      };
    },
  };
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw signal.reason;
  }

  return await new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}
