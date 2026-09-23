import type { ModelResponse, RunItem } from './model.ts';

export class RunResult {
  readonly finalOutput: string;
  readonly history: readonly RunItem[];
  readonly rawResponses: readonly ModelResponse[];
  readonly turns: number;

  constructor(options: {
    finalOutput: string;
    history: RunItem[];
    rawResponses: ModelResponse[];
    turns: number;
  }) {
    this.finalOutput = options.finalOutput;
    this.history = options.history;
    this.rawResponses = options.rawResponses;
    this.turns = options.turns;
  }
}
