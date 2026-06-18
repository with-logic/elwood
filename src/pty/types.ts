/**
 * PTY abstraction for real and fake terminal processes.
 * Implements PRD §4.1 and §5.3.
 */

import type { TerminalSize } from "../core/types.ts";

export type PtyExit = {
  readonly exitCode: number;
  readonly signal?: number;
};

export type PtySpawnOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly size: TerminalSize;
};

export interface PtyProcess {
  readonly pid: number;
  onData(handler: (data: string) => void): () => void;
  onExit(handler: (exit: PtyExit) => void): () => void;
  write(data: string | Uint8Array): void;
  resize(size: TerminalSize): "resized" | "closed";
  kill(signal?: string): void;
}

export type PtyFactory = (options: PtySpawnOptions) => PtyProcess;
