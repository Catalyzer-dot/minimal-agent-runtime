import { Agent } from './agent.ts';
import type { RunEventHandler } from './events.ts';
import type {
  AssistantMessage,
  ModelResponse,
  RunItem,
  ToolCall,
} from './model.ts';
import { RunResult, StreamedRunResult } from './result.ts';
import { invokeFunctionTool, ToolTimeoutError } from './tool.ts';

export type RunOptions = {
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: RunEventHandler;
};

export class MaxTurnsExceededError extends Error {}
export class ModelBehaviorError extends Error {}

export class Runner {
  readonly defaultMaxTurns: number;

  constructor(options: RunOptions = {}) {
    this.defaultMaxTurns = options.maxTurns ?? 10;
  }

  async run(
    agent: Agent,
    input: string,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const maxTurns = options.maxTurns ?? this.defaultMaxTurns;
    const history: RunItem[] = [{ type: 'user_message', content: input }];
    const rawResponses: ModelResponse[] = [];

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      options.signal?.throwIfAborted();

      const response = await agent.model.getResponse({
        instructions: agent.instructions,
        input: [...history],
        tools: agent.tools.map(({ name, description, parameters }) => ({
          type: 'function' as const,
          name,
          description,
          parameters,
        })),
        signal: options.signal,
      });

      rawResponses.push(response);
      history.push(...response.output);

      const toolCalls = response.output.filter(
        (item): item is ToolCall => item.type === 'tool_call',
      );

      if (toolCalls.length === 0) {
        const finalMessage = findLastMessage(response.output);
        if (!finalMessage) {
          throw new ModelBehaviorError(
            'The model returned neither a message nor a tool call.',
          );
        }

        return new RunResult({
          finalOutput: finalMessage.content,
          history,
          rawResponses,
          turns: turn,
        });
      }

      for (const toolCall of toolCalls) {
        const selectedTool = agent.tools.find(
          (candidate) => candidate.name === toolCall.name,
        );

        if (!selectedTool) {
          throw new ModelBehaviorError(
            `Model requested unknown tool: ${toolCall.name}`,
          );
        }

        const eventBase = {
          turn,
          callId: toolCall.callId,
          toolName: toolCall.name,
        };
        options.onEvent?.({ type: 'tool_started', ...eventBase });

        try {
          const output = await invokeFunctionTool(
            selectedTool,
            toolCall.arguments,
            options.signal,
          );
          history.push({
            type: 'tool_result',
            callId: toolCall.callId,
            name: toolCall.name,
            output,
            isError: false,
          });
          options.onEvent?.({
            type: 'tool_completed',
            ...eventBase,
            output,
          });
        } catch (error) {
          if (options.signal?.aborted) {
            options.onEvent?.({
              type: 'tool_cancelled',
              ...eventBase,
              reason: formatError(error),
            });
            throw error;
          }

          if (error instanceof ToolTimeoutError) {
            options.onEvent?.({
              type: 'tool_timed_out',
              ...eventBase,
              timeoutMs: error.timeoutMs,
              behavior: selectedTool.timeoutBehavior,
            });

            if (selectedTool.timeoutBehavior === 'raise_exception') {
              throw error;
            }
          } else {
            options.onEvent?.({
              type: 'tool_failed',
              ...eventBase,
              error: formatError(error),
            });
          }

          history.push({
            type: 'tool_result',
            callId: toolCall.callId,
            name: toolCall.name,
            output: `Tool error: ${formatError(error)}`,
            isError: true,
          });
        }
      }
    }

    throw new MaxTurnsExceededError(`Max turns (${maxTurns}) exceeded.`);
  }

  stream(
    agent: Agent,
    input: string,
    options: RunOptions = {},
  ): StreamedRunResult {
    return new StreamedRunResult(this.runStream(agent, input, options));
  }

  /**
   * Streaming variant. Model deltas are observable, but tool execution still
   * starts only after the provider has emitted a complete ModelResponse.
   */
  async *runStream(
    agent: Agent,
    input: string,
    options: RunOptions = {},
  ): AsyncGenerator<import('./events.ts').RunEvent, RunResult, void> {
    const maxTurns = options.maxTurns ?? this.defaultMaxTurns;
    const history: RunItem[] = [{ type: 'user_message', content: input }];
    const rawResponses: ModelResponse[] = [];
    const emit = (event: import('./events.ts').RunEvent) => {
      options.onEvent?.(event);
    };

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      options.signal?.throwIfAborted();
      const request = {
        instructions: agent.instructions,
        input: [...history],
        tools: agent.tools.map(({ name, description, parameters }) => ({
          type: 'function' as const, name, description, parameters,
        })),
        signal: options.signal,
      };
      let response: ModelResponse | undefined;
      if (agent.model.getResponseStream) {
        for await (const event of agent.model.getResponseStream(request)) {
          if (event.type === 'completed') response = event.response;
          else {
            const runEvent = event.type === 'text_delta'
              ? { type: 'text_delta' as const, turn, delta: event.delta }
              : { type: 'tool_call_delta' as const, turn, index: event.index, callId: event.callId, name: event.name, argumentsDelta: event.argumentsDelta };
            emit(runEvent);
            yield runEvent;
          }
        }
      } else {
        response = await agent.model.getResponse(request);
        const message = findLastMessage(response.output);
        if (message) {
          const runEvent = { type: 'text_delta' as const, turn, delta: message.content };
          emit(runEvent);
          yield runEvent;
        }
      }
      if (!response) throw new ModelBehaviorError('Streaming model ended without a completed response.');
      rawResponses.push(response);
      history.push(...response.output);
      const toolCalls = response.output.filter((item): item is ToolCall => item.type === 'tool_call');
      if (toolCalls.length === 0) {
        const finalMessage = findLastMessage(response.output);
        if (!finalMessage) throw new ModelBehaviorError('The model returned neither a message nor a tool call.');
        return new RunResult({ finalOutput: finalMessage.content, history, rawResponses, turns: turn });
      }
      for (const toolCall of toolCalls) {
        const selectedTool = agent.tools.find((candidate) => candidate.name === toolCall.name);
        if (!selectedTool) throw new ModelBehaviorError(`Model requested unknown tool: ${toolCall.name}`);
        const eventBase = { turn, callId: toolCall.callId, toolName: toolCall.name };
        const started = { type: 'tool_started' as const, ...eventBase };
        emit(started); yield started;
        try {
          const output = await invokeFunctionTool(selectedTool, toolCall.arguments, options.signal);
          history.push({ type: 'tool_result', callId: toolCall.callId, name: toolCall.name, output, isError: false });
          const completed = { type: 'tool_completed' as const, ...eventBase, output };
          emit(completed); yield completed;
        } catch (error) {
          if (options.signal?.aborted) {
            const cancelled = { type: 'tool_cancelled' as const, ...eventBase, reason: formatError(error) };
            emit(cancelled); yield cancelled; throw error;
          }
          if (error instanceof ToolTimeoutError) {
            const timedOut = { type: 'tool_timed_out' as const, ...eventBase, timeoutMs: error.timeoutMs, behavior: selectedTool.timeoutBehavior };
            emit(timedOut); yield timedOut;
            if (selectedTool.timeoutBehavior === 'raise_exception') throw error;
          } else {
            const failed = { type: 'tool_failed' as const, ...eventBase, error: formatError(error) };
            emit(failed); yield failed;
          }
          history.push({ type: 'tool_result', callId: toolCall.callId, name: toolCall.name, output: `Tool error: ${formatError(error)}`, isError: true });
        }
      }
    }
    throw new MaxTurnsExceededError(`Max turns (${maxTurns}) exceeded.`);
  }
}

export async function run(
  agent: Agent,
  input: string,
  options?: RunOptions,
): Promise<RunResult> {
  return new Runner().run(agent, input, options);
}

function findLastMessage(
  output: ModelResponse['output'],
): AssistantMessage | undefined {
  return [...output]
    .reverse()
    .find((item): item is AssistantMessage => item.type === 'assistant_message');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
