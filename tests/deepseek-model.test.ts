import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepSeekModel } from '../src/index.ts';

test('maps DeepSeek tool calls into the internal model protocol', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_deepseek_1',
                  type: 'function',
                  function: {
                    name: 'calculator',
                    arguments: '{"left":16,"right":6}',
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const model = new DeepSeekModel({ apiKey: 'test-key' });
    const response = await model.getResponse({
      instructions: 'Use tools.',
      input: [{ type: 'user_message', content: 'Calculate 16 + 6.' }],
      tools: [
        {
          type: 'function',
          name: 'calculator',
          description: 'Add numbers.',
          parameters: { type: 'object' },
        },
      ],
    });

    assert.deepEqual(response.output, [
      {
        type: 'tool_call',
        callId: 'call_deepseek_1',
        name: 'calculator',
        arguments: '{"left":16,"right":6}',
      },
    ]);
    assert.deepEqual(requestBody, {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Use tools.' },
        { role: 'user', content: 'Calculate 16 + 6.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Add numbers.',
            parameters: { type: 'object' },
          },
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not expose the API key in HTTP errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });

  try {
    await assert.rejects(
      new DeepSeekModel({ apiKey: 'secret-test-key' }).getResponse({
        instructions: 'test',
        input: [{ type: 'user_message', content: 'test' }],
        tools: [],
      }),
      (error: Error) => {
        assert.match(error.message, /invalid key/);
        assert.doesNotMatch(error.message, /secret-test-key/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('aggregates streamed text and tool call argument deltas', async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stream_1","type":"function","function":{"name":"calculator","arguments":"{\\"left\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"正在计算"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"16,\\"right\\":6}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"。"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  try {
    const model = new DeepSeekModel({ apiKey: 'test-key' });
    const events = [];
    for await (const event of model.getResponseStream!({
      instructions: 'Use tools.', input: [{ type: 'user_message', content: 'Calculate.' }], tools: [],
    })) events.push(event);
    assert.deepEqual(events.filter((event) => event.type === 'text_delta').map((event) => event.delta), ['正在计算', '。']);
    const completed = events.find((event) => event.type === 'completed');
    assert.ok(completed && completed.type === 'completed');
    assert.deepEqual(completed.response.output, [
      { type: 'assistant_message', content: '正在计算。' },
      { type: 'tool_call', callId: 'call_stream_1', name: 'calculator', arguments: '{"left":16,"right":6}' },
    ]);
  } finally { globalThis.fetch = originalFetch; }
});
