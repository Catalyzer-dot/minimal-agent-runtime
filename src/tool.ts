import { z } from 'zod';

export type ToolTimeoutBehavior = 'error_as_result' | 'raise_exception';

export type ToolExecutionContext = {
  signal: AbortSignal;
};

export type FunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
  timeoutBehavior: ToolTimeoutBehavior;
  invoke(input: string, context: ToolExecutionContext): Promise<string>;
};

export type ToolOptions<TParameters, TResult> = {
  name: string;
  description: string;
  parameters: z.ZodType<TParameters>;
  timeoutMs?: number;
  timeoutBehavior?: ToolTimeoutBehavior;
  execute(
    parameters: TParameters,
    context: ToolExecutionContext,
  ): Promise<TResult> | TResult;
};

export class ToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool '${toolName}' timed out after ${timeoutMs}ms.`);
    this.name = 'ToolTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

export function tool<TParameters, TResult>(
  options: ToolOptions<TParameters, TResult>,
): FunctionTool {
  validateTimeout(options.name, options.timeoutMs);

  return {
    type: 'function',
    name: options.name,
    description: options.description,
    parameters: z.toJSONSchema(options.parameters) as Record<string, unknown>,
    timeoutMs: options.timeoutMs,
    timeoutBehavior: options.timeoutBehavior ?? 'error_as_result',
    async invoke(
      input: string,
      context: ToolExecutionContext,
    ): Promise<string> {
      const json: unknown = JSON.parse(input);
      const parameters = await options.parameters.parseAsync(json);
      const result = await options.execute(parameters, context);

      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  };
}

export async function invokeFunctionTool(
  selectedTool: FunctionTool,
  input: string,
  parentSignal?: AbortSignal,
): Promise<string> {
  parentSignal?.throwIfAborted();

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: (reason: Error) => void = () => {};

  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });

  const abort = (reason: unknown) => {
    const error = toError(reason, 'Tool execution was cancelled.');
    rejectCancellation(error);
    controller.abort(error);
  };

  const onParentAbort = () => abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  if (selectedTool.timeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      abort(new ToolTimeoutError(selectedTool.name, selectedTool.timeoutMs!));
    }, selectedTool.timeoutMs);
  }

  try {
    return await Promise.race([
      selectedTool.invoke(input, { signal: controller.signal }),
      cancellation,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

function validateTimeout(toolName: string, timeoutMs?: number): void {
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new Error(`Tool '${toolName}' timeoutMs must be greater than 0.`);
  }
}

function toError(reason: unknown, fallbackMessage: string): Error {
  return reason instanceof Error ? reason : new Error(fallbackMessage);
}
