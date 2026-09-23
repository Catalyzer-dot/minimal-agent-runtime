import type {
  AssistantMessage,
  Model,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolCall,
  ToolResult,
} from './model.ts';

export type DeepSeekModelOptions = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: { message?: string; type?: string };
};

type DeepSeekStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

export class DeepSeekModel implements Model {
  readonly model: string;
  private readonly apiKey: string;
  readonly baseUrl: string;

  constructor(options: DeepSeekModelOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
    this.baseUrl = (
      options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
    ).replace(/\/$/, '');

    if (!this.apiKey) {
      throw new Error(
        'Missing DeepSeek API key. Set DEEPSEEK_API_KEY or pass apiKey explicitly.',
      );
    }
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: toChatMessages(request),
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
      }),
      signal: request.signal,
    });

    const body = (await response.json()) as DeepSeekResponse;
    if (!response.ok) {
      throw new Error(
        `DeepSeek request failed (${response.status}): ${body.error?.message ?? 'unknown error'}`,
      );
    }

    const message = body.choices?.[0]?.message;
    if (!message) {
      throw new Error('DeepSeek response did not contain choices[0].message.');
    }

    const output: Array<AssistantMessage | ToolCall> = [];
    if (message.content) {
      output.push({ type: 'assistant_message', content: message.content });
    }

    for (const toolCall of message.tool_calls ?? []) {
      if (
        toolCall.type !== 'function' ||
        !toolCall.id ||
        !toolCall.function?.name ||
        toolCall.function.arguments === undefined
      ) {
        throw new Error('DeepSeek returned an invalid function tool call.');
      }

      output.push({
        type: 'tool_call',
        callId: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }

    if (output.length === 0) {
      throw new Error('DeepSeek returned an empty assistant message.');
    }

    return { output };
  }

  async *getResponseStream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: toChatMessages(request),
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DeepSeek streaming request failed (${response.status}): ${extractError(body)}`);
    }
    if (!response.body) throw new Error('DeepSeek streaming response has no body.');

    const textParts: string[] = [];
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const data of readSseData(response.body)) {
      if (data === '[DONE]') break;
      let chunk: DeepSeekStreamChunk;
      try { chunk = JSON.parse(data) as DeepSeekStreamChunk; }
      catch { throw new Error('DeepSeek returned invalid streaming JSON.'); }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        textParts.push(delta.content);
        yield { type: 'text_delta', delta: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        toolCalls.set(index, current);
        yield {
          type: 'tool_call_delta', index,
          callId: call.id, name: call.function?.name,
          argumentsDelta: call.function?.arguments,
        };
      }
    }

    const output: Array<AssistantMessage | ToolCall> = [];
    const content = textParts.join('');
    if (content) output.push({ type: 'assistant_message', content });
    for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
      if (!call.id || !call.name || !call.arguments) throw new Error('DeepSeek returned an incomplete streaming function call.');
      output.push({ type: 'tool_call', callId: call.id, name: call.name, arguments: call.arguments });
    }
    if (output.length === 0) throw new Error('DeepSeek returned an empty streaming assistant message.');
    const result = { output };
    yield { type: 'completed', response: result };
  }
}

function extractError(body: string): string {
  try { return (JSON.parse(body) as DeepSeekResponse).error?.message ?? 'unknown error'; }
  catch { return 'unknown error'; }
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
      if (done) break;
    }
    if (buffer.startsWith('data:')) yield buffer.slice(5).trim();
  } finally { reader.releaseLock(); }
}

function toChatMessages(request: ModelRequest): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: request.instructions },
  ];

  let pendingToolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
      pendingToolCalls = [];
    }
  };

  for (const item of request.input) {
    if (item.type === 'user_message') {
      flushToolCalls();
      messages.push({ role: 'user', content: item.content });
    } else if (item.type === 'assistant_message') {
      flushToolCalls();
      messages.push({ role: 'assistant', content: item.content });
    } else if (item.type === 'tool_call') {
      pendingToolCalls.push({
        id: item.callId,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    } else {
      flushToolCalls();
      messages.push(toToolMessage(item));
    }
  }

  flushToolCalls();
  return messages;
}

function toToolMessage(item: ToolResult): ChatMessage {
  return {
    role: 'tool',
    tool_call_id: item.callId,
    content: item.output,
  };
}
