/**
 * Shared message types and parsing helpers for the browser dev app.
 * Implements PRD §11.
 */

import type { TerminalSize } from "../index.ts";
import type { AgentKind } from "./agent-runtime.ts";

export type ClientMessage =
  | {
      readonly type: "start";
      readonly agent?: AgentKind;
      readonly cwd: string;
      readonly stateDir?: string;
      /** Elwood session id to resume (the public id), not an adapter `resumeId`. */
      readonly elwoodSessionId?: string;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly type: "prompt"; readonly value: string }
  | { readonly type: "keys"; readonly value: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "stop" }
  | { readonly type: "kill" }
  | { readonly type: "teardown" };

/** The message `type` discriminants the browser client may send. */
export type ClientMessageType = ClientMessage["type"];

export type DebugEventLevel = "info" | "success" | "warn" | "error";
export type DebugEventKind =
  | "session"
  | "status"
  | "hook"
  | "activity"
  | "warning"
  | "hookError"
  | "terminal"
  | "error"
  | "log";

export type DebugEventEntry = {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: DebugEventKind;
  readonly level: DebugEventLevel;
  readonly badge: string;
  readonly title: string;
  readonly summary: string;
  readonly tags?: readonly string[];
  readonly raw?: unknown;
};

export type ServerMessage =
  | { readonly type: "terminal"; readonly data: string }
  | { readonly type: "event"; readonly entry: DebugEventEntry }
  | { readonly type: "session"; readonly id: string; readonly cwd: string; readonly status: string }
  | { readonly type: "status"; readonly status: string };

export { parseClientMessage } from "./web-parse.ts";

export function sizeFrom(input: { readonly cols: number; readonly rows: number }): TerminalSize {
  return { cols: input.cols, rows: input.rows };
}
