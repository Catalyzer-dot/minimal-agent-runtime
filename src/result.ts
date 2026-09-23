import type { RunEvent } from './events.ts';
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

type EventWaiter = {
  resolve: (result: IteratorResult<RunEvent>) => void;
  reject: (error: unknown) => void;
};

/** A stream handle that exposes both incremental events and the final result. */
export class StreamedRunResult implements AsyncIterable<RunEvent> {
  readonly completed: Promise<RunResult>;
  private readonly queue: RunEvent[] = [];
  private readonly waiters: EventWaiter[] = [];
  private resolveCompleted!: (result: RunResult) => void;
  private rejectCompleted!: (error: unknown) => void;
  private finished = false;

  constructor(source: AsyncGenerator<RunEvent, RunResult, void>) {
    this.completed = new Promise<RunResult>((resolve, reject) => {
      this.resolveCompleted = resolve;
      this.rejectCompleted = reject;
    });
    void this.consume(source);
  }

  async *events(): AsyncGenerator<RunEvent> {
    yield* this;
  }

  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    return { next: () => this.nextEvent() };
  }

  private async nextEvent(): Promise<IteratorResult<RunEvent>> {
    const event = this.queue.shift();
    if (event) return { done: false, value: event };
    if (this.finished) return { done: true, value: undefined };
    return new Promise<IteratorResult<RunEvent>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private push(event: RunEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.queue.push(event);
  }

  private finish(): void {
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  private async consume(source: AsyncGenerator<RunEvent, RunResult, void>): Promise<void> {
    try {
      while (true) {
        const step = await source.next();
        if (step.done) {
          this.resolveCompleted(step.value);
          this.finish();
          return;
        }
        this.push(step.value);
      }
    } catch (error) {
      this.rejectCompleted(error);
      this.finished = true;
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    }
  }
}
