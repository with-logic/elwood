/**
 * Canonical, safe version-1 records shared by every CLI output protocol.
 * Implements PRD §12A.3 and C-CLI-10 through C-CLI-12.
 */

import type { ElwoodSessionStatus } from "../../core/types.ts";
import type { CliAgent } from "../types.ts";

export type CliCleanupAction = "none" | "preserve" | "teardown";
export type CliCleanup = {
  readonly action: CliCleanupAction;
  readonly status: "succeeded" | "failed";
  readonly error?: string;
};

export type CliTerminalBase = {
  readonly schemaVersion: 1;
  readonly response: string;
  readonly sessionId: string | null;
  readonly durationMs: number;
  readonly cleanup: CliCleanup;
};

export type CliResult = CliTerminalBase & { readonly type: "result"; readonly agent: CliAgent };
/** `agent` is `null` only for failures raised before anything selected an agent. */
export type CliError = CliTerminalBase & {
  readonly type: "error";
  readonly agent: CliAgent | null;
  readonly error: { readonly code: string; readonly message: string };
};
export type CliTerminalRecord = CliResult | CliError;

export type CliProgressRecord =
  | { readonly schemaVersion: 1; readonly type: "text"; readonly text: string }
  | { readonly schemaVersion: 1; readonly type: "thinking"; readonly text: string }
  | {
      readonly schemaVersion: 1;
      readonly type: "tool";
      readonly phase: "call";
      readonly name: string;
      readonly content?: string;
      readonly toolCallId?: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "tool";
      readonly phase: "result";
      readonly name?: string;
      readonly content?: string;
      readonly toolCallId?: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "status";
      readonly status: ElwoodSessionStatus;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "warning";
      readonly code: string;
      readonly message: string;
    };

export type CliJsonlRecord =
  | (CliProgressRecord & { readonly sequence: number; readonly elapsedMs: number })
  | (CliTerminalRecord & { readonly sequence: number; readonly elapsedMs: number });

export type CliTextSanitizer = (value: string) => string;
