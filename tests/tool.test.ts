import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { invokeFunctionTool, tool, ToolTimeoutError } from '../src/index.ts';

test('parses and validates arguments before execute', async () => {
  const concatenate = tool({
    name: 'concatenate',
    description: 'Join two strings.',
    parameters: z.object({ left: z.string(), right: z.string() }),
    execute: ({ left, right }) => left + right,
  });

  const output = await invokeFunctionTool(
    concatenate,
    JSON.stringify({ left: 'Agent', right: ' Runtime' }),
  );

  assert.equal(output, 'Agent Runtime');
  await assert.rejects(
    invokeFunctionTool(
      concatenate,
      JSON.stringify({ left: 'Agent', right: 123 }),
    ),
    z.ZodError,
  );
});

test('rejects invalid timeout configuration', () => {
  assert.throws(
    () =>
      tool({
        name: 'invalid_timeout',
        description: 'Invalid timeout.',
        parameters: z.object({}),
        timeoutMs: 0,
        execute: () => 'never',
      }),
    /timeoutMs must be greater than 0/,
  );
});

test('aborts execute and raises ToolTimeoutError', async () => {
  let receivedAbort = false;
  const slowTool = tool({
    name: 'slow_tool',
    description: 'Wait forever.',
    parameters: z.object({}),
    timeoutMs: 5,
    execute: async (_, { signal }) => {
      await new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            receivedAbort = signal.aborted;
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return 'unreachable';
    },
  });

  await assert.rejects(
    invokeFunctionTool(slowTool, '{}'),
    ToolTimeoutError,
  );
  assert.equal(receivedAbort, true);
});
