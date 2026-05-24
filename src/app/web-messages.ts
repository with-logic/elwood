/**
 * Shared message types and parsing helpers for the browser dev app.
 * Implements PRD §10.
 */

import type { TerminalSize } from "../index.ts";
import type { AgentKind } from "./agent-runtime.ts";

export type ClientMessage =
  | {
      readonly type: "start";
      readonly agent?: AgentKind;
      readonly cwd: string;
      readonly stateDir?: string;
      readonly resumeSessionId?: string;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly type: "prompt"; readonly value: string }
  | { readonly type: "keys"; readonly value: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "kill" }
  | { readonly type: "teardown" };

export type ServerMessage =
  | { readonly type: "terminal"; readonly data: string }
  | { readonly type: "log"; readonly level: "info" | "error"; readonly text: string }
  | { readonly type: "session"; readonly id: string; readonly cwd: string; readonly status: string }
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "error"; readonly message: string };

export function parseClientMessage(raw: string): ClientMessage {
  const parsed = JSON.parse(raw) as ClientMessage;
  if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
    throw new Error("Invalid client message.");
  }
  return parsed;
}

export function sizeFrom(input: { readonly cols: number; readonly rows: number }): TerminalSize {
  return { cols: input.cols, rows: input.rows };
}
