/**
 * Codex PTY spawning with login-shell semantics, and the config path that launch's session
 * uses. Implements PRD §4.1, §4.2, §5.3, and §5.5.
 */

import { defaultTerminalSize } from "../core/defaults.ts";
import { causeDetails, elwoodError } from "../core/errors.ts";
import type { PtyProcess } from "../pty/types.ts";
import { currentPtyFactory } from "../runtime/seams.ts";
import { loginShellCommand, userShell } from "../runtime/shell.ts";
import type { SessionRecord } from "../state/store.ts";
import { buildCodexShellCommand } from "./command.ts";
import { codexConfigPath } from "./config/restore.ts";
import * as preflight from "./preflight.ts";
import type { StartCodexOptions } from "./session/types.ts";

export type CodexLaunch = {
  readonly pty: PtyProcess;
  /** The config.toml this session reads its default from and restores (PRD §5.3). */
  readonly configPath: string;
};

export async function spawnCodexPty(
  record: SessionRecord,
  bridgeScriptPath: string,
  options: StartCodexOptions,
): Promise<CodexLaunch> {
  const capabilities = await preflight.detectCodexCliCapabilities();
  const configPath = codexConfigPath();
  try {
    const pty = currentPtyFactory()({
      command: userShell(),
      args: loginShellCommand(
        buildCodexShellCommand(record, bridgeScriptPath, options, capabilities),
      ),
      cwd: record.cwd,
      env: { ...process.env, ELWOOD_SESSION_ID: record.elwoodSessionId },
      size: options.initialSize ?? defaultTerminalSize,
    });
    return { pty, configPath };
  } catch (error) {
    throw elwoodError("pty_start_failed", "Could not start Codex PTY.", causeDetails(error));
  }
}
