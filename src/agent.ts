import type { Model } from './model.ts';
import type { FunctionTool } from './tool.ts';

export type AgentOptions = {
  name: string;
  instructions: string;
  model: Model;
  tools?: FunctionTool[];
};

export class Agent {
  readonly name: string;
  readonly instructions: string;
  readonly model: Model;
  readonly tools: readonly FunctionTool[];

  constructor(options: AgentOptions) {
    if (options.name.trim() === '') {
      throw new Error('Agent name cannot be empty.');
    }

    this.name = options.name;
    this.instructions = options.instructions;
    this.model = options.model;
    this.tools = options.tools ?? [];
  }
}
