import type { ToolTimeoutBehavior } from './tool.ts';

type ToolEventBase = {
  turn: number;
  callId: string;
  toolName: string;
};

export type RunEvent =
  | { type: 'text_delta'; turn: number; delta: string }
  | {
      type: 'tool_call_delta';
      turn: number;
      index: number;
      callId?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | (ToolEventBase & { type: 'tool_started' })
  | (ToolEventBase & { type: 'tool_completed'; output: string })
  | (ToolEventBase & { type: 'tool_failed'; error: string })
  | (ToolEventBase & {
      type: 'tool_timed_out';
      timeoutMs: number;
      behavior: ToolTimeoutBehavior;
    })
  | (ToolEventBase & { type: 'tool_cancelled'; reason: string });

export type RunEventHandler = (event: RunEvent) => void;
