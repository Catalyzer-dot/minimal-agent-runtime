import { Agent } from './agent.ts';
import type {
  AssistantMessage,
  ModelResponse,
  RunItem,
  ToolCall,
} from './model.ts';
import { RunResult } from './result.ts';

export type RunOptions = {
  maxTurns?: number;
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
      const response = await agent.model.getResponse({
        instructions: agent.instructions,
        input: [...history],
        tools: agent.tools.map(({ name, description, parameters }) => ({
          type: 'function' as const,
          name,
          description,
          parameters,
        })),
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

        try {
          const output = await selectedTool.invoke(toolCall.arguments);
          history.push({
            type: 'tool_result',
            callId: toolCall.callId,
            name: toolCall.name,
            output,
            isError: false,
          });
        } catch (error) {
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
