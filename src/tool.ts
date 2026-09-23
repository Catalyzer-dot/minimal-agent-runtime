import { z } from 'zod';

export type FunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  invoke(input: string): Promise<string>;
};

export type ToolOptions<TParameters, TResult> = {
  name: string;
  description: string;
  parameters: z.ZodType<TParameters>;
  execute(parameters: TParameters): Promise<TResult> | TResult;
};

export function tool<TParameters, TResult>(
  options: ToolOptions<TParameters, TResult>,
): FunctionTool {
  return {
    type: 'function',
    name: options.name,
    description: options.description,
    parameters: z.toJSONSchema(options.parameters) as Record<string, unknown>,
    async invoke(input: string): Promise<string> {
      const json: unknown = JSON.parse(input);
      const parameters = await options.parameters.parseAsync(json);
      const result = await options.execute(parameters);

      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  };
}
