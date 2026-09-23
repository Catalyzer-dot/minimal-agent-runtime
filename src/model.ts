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
};

export type ModelResponse = {
  output: readonly ModelOutput[];
};

export interface Model {
  getResponse(request: ModelRequest): Promise<ModelResponse>;
}
