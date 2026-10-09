import type { ToolTimeoutBehavior } from './tool.ts';

type ToolEventBase = {
  runId: string;
  turn: number;
  callId: string;
  toolName: string;
};

export type RunEvent =
  | { type: 'run_started'; runId: string }
  | { type: 'run_completed'; runId: string; turns: number; durationMs: number }
  | { type: 'run_limit_exceeded'; runId: string; reason: string }
  | { type: 'model_started'; runId: string; turn: number }
  | { type: 'model_completed'; runId: string; turn: number; durationMs: number }
  | { type: 'text_delta'; runId: string; turn: number; delta: string }
  | {
      type: 'tool_call_delta';
      runId: string;
      turn: number;
      index: number;
      callId?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | (ToolEventBase & { type: 'tool_started' })
  | (ToolEventBase & { type: 'tool_completed'; output: string; durationMs: number })
  | (ToolEventBase & { type: 'tool_failed'; error: string })
  | (ToolEventBase & {
      type: 'tool_timed_out';
      timeoutMs: number;
      behavior: ToolTimeoutBehavior;
    })
  | (ToolEventBase & { type: 'tool_cancelled'; reason: string });

export type RunEventHandler = (event: RunEvent) => void;
