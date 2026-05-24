/**
 * Codex PTY spawning with login-shell semantics.
 * Implements PRD §4.1, §4.2, and §5.5.
 */

import { resolve } from "node:path";
import { elwoodError } from "../core/errors.ts";
import type { TerminalSize } from "../core/types.ts";
import type { PtyProcess } from "../pty/types.ts";
import { currentPtyFactory } from "../runtime/seams.ts";
import type { SessionRecord } from "../state/store.ts";
import { buildCodexShellCommand } from "./command.ts";
import * as preflight from "./preflight.ts";
import type { StartCodexOptions } from "./session-types.ts";

const defaultSize: TerminalSize = { cols: 189, rows: 48 };

export function spawnCodexPty(record: SessionRecord, options: StartCodexOptions): PtyProcess {
  const shell = process.env["SHELL"] ?? "/bin/zsh";
  const capabilities = preflight.detectCodexCliCapabilities();
  try {
    return currentPtyFactory()({
      command: shell,
      args: ["-l", "-i", "-c", buildCodexShellCommand(record, options, capabilities)],
      cwd: resolve(options.cwd),
      env: { ...process.env, ELWOOD_SESSION_ID: record.elwoodSessionId },
      size: options.initialSize ?? record.terminalSize ?? defaultSize,
    });
  } catch (error) {
    throw elwoodError("pty_start_failed", "Could not start Codex PTY.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
