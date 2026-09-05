/** Terminal boundary for CLI head mode. Implements PRD §12A.6 and C-CLI-18. */

import type { TerminalSize, Unsubscribe } from "../../core/types.ts";
import type { CliWritable } from "../stream.ts";

export type CliHeadTarget = {
  readonly output: CliWritable;
  readonly size: () => TerminalSize;
  readonly isRaw: () => boolean;
  readonly setRawMode: (enabled: boolean) => void;
  readonly resume: () => void;
  readonly pause: () => void;
  readonly onInput: (handler: (data: string | Uint8Array) => void) => Unsubscribe;
  readonly onResize: (handler: (size: TerminalSize) => void) => Unsubscribe;
};

export type HeadedDisplayHandlers = {
  readonly interrupt: () => void;
  readonly resize: (size: TerminalSize) => void | Promise<void>;
  readonly failed: (error: unknown) => void;
};
