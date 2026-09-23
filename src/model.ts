export type UserMessage = {
  type: 'user_message';
  content: string;
};

export type AssistantMessage = {
  type: 'assistant_message';
  content: string;
};

export type ToolCall = {
  type: 'tool_call';
  callId: string;
  name: string;
  arguments: string;
};

export type ToolResult = {
  type: 'tool_result';
  callId: string;
  name: string;
  output: string;
  isError: boolean;
};

export type RunItem =
  | UserMessage
  | AssistantMessage
  | ToolCall
  | ToolResult;

export type ModelOutput = AssistantMessage | ToolCall;

export type ModelToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ModelRequest = {
  instructions: string;
  input: readonly RunItem[];
  tools: readonly ModelToolDefinition[];
  signal?: AbortSignal;
};

export type ModelResponse = {
  output: readonly ModelOutput[];
};

export type ModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  | {
      type: 'tool_call_delta';
      index: number;
      callId?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'completed'; response: ModelResponse };

export interface Model {
  getResponse(request: ModelRequest): Promise<ModelResponse>;
  getResponseStream?(request: ModelRequest): AsyncGenerator<ModelStreamEvent>;
}
