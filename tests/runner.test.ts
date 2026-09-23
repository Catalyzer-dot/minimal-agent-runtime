import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  Agent,
  MaxTurnsExceededError,
  ModelBehaviorError,
  run,
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from '../src/index.ts';

const echoTool = tool({
  name: 'echo',
  description: 'Echo a message.',
  parameters: z.object({ message: z.string() }),
  execute: ({ message }) => message,
});

test('executes a tool and gives its result back to the model', async () => {
  const requests: ModelRequest[] = [];
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
  );

  assert.equal(result.finalOutput, 'hello');
  assert.equal(result.turns, 2);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].input.some((item) => item.type === 'tool_result'),
    true,
  );
});

test('returns tool validation errors to the model', async () => {
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
  );

  assert.equal(result.finalOutput, '参数错误已处理');
  assert.equal(
    result.history.some(
      (item) => item.type === 'tool_result' && item.isError,
    ),
    true,
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
