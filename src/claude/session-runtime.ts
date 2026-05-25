/**
 * Runtime file and PTY helpers for Claude sessions.
 * Implements PRD §4, §6, and §9.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bridgeScriptSource } from "../bridge/script.ts";
import { defaultTerminalSize } from "../core/defaults.ts";
import { elwoodError } from "../core/errors.ts";
import type { ElwoodEventHandler, ElwoodEventName, StartClaudeOptions } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import { currentPtyFactory } from "../runtime/seams.ts";
import { userShell } from "../runtime/shell.ts";
import type { SessionRecord } from "../state/store.ts";
import { buildClaudeShellCommand, shellLaunch } from "./command.ts";
import { generateClaudeSettings } from "./settings.ts";

export function writeRuntimeFiles(
  record: SessionRecord,
  token: string,
  options: StartClaudeOptions,
): void {
  writeFileSync(record.paths.bridgeScriptPath, bridgeScriptSource(record.paths.socketPath, token));
  const settings = generateClaudeSettings({
    bridgeScriptPath: record.paths.bridgeScriptPath,
    options,
    timeoutSeconds: Math.ceil((options.hookTimeoutMs ?? 25_000) / 1000),
  });
  writeFileSync(record.paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function spawnClaudePty(record: SessionRecord, options: StartClaudeOptions): PtyProcess {
  const launch = shellLaunch(
    userShell(),
    buildClaudeShellCommand(record.paths.settingsPath, options, record.claude.resumeId),
  );
  try {
    return currentPtyFactory()({
      command: launch.command,
      args: launch.args,
      cwd: resolve(options.cwd),
      env: {
        ...process.env,
        ELWOOD_SESSION_ID: record.elwoodSessionId,
      },
      size: options.initialSize ?? record.terminalSize ?? defaultTerminalSize,
    });
  } catch (error) {
    throw elwoodError("pty_start_failed", "Could not start Claude PTY.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerInitialHooks(
  emitter: TypedEmitter,
  handlers: StartClaudeOptions["hooks"],
): void {
  if (!handlers) return;
  for (const [name, handler] of Object.entries(handlers)) {
    emitter.listen(
      `hook:${name}` as ElwoodEventName,
      handler as ElwoodEventHandler<ElwoodEventName>,
    );
  }
}
