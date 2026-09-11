/**
 * Codex PTY spawning with login-shell semantics.
 * Implements PRD §4.1, §4.2, and §5.5.
 */

import { defaultTerminalSize } from "../core/defaults.ts";
import { causeDetails, elwoodError } from "../core/errors.ts";
import type { PtyProcess } from "../pty/types.ts";
import { currentPtyFactory } from "../runtime/seams.ts";
import { loginShellCommand, userShell } from "../runtime/shell.ts";
import type { SessionRecord } from "../state/store.ts";
import { buildCodexShellCommand } from "./command.ts";
import * as preflight from "./preflight.ts";
import type { StartCodexOptions } from "./session/types.ts";

export async function spawnCodexPty(
  record: SessionRecord,
  bridgeScriptPath: string,
  options: StartCodexOptions,
): Promise<PtyProcess> {
  const capabilities = await preflight.detectCodexCliCapabilities();
  try {
    return currentPtyFactory()({
      command: userShell(),
      args: loginShellCommand(
        buildCodexShellCommand(record, bridgeScriptPath, options, capabilities),
      ),
      cwd: record.cwd,
      env: { ...process.env, ELWOOD_SESSION_ID: record.elwoodSessionId },
      size: options.initialSize ?? defaultTerminalSize,
    });
  } catch (error) {
    throw elwoodError("pty_start_failed", "Could not start Codex PTY.", causeDetails(error));
  }
}
