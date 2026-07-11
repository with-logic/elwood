/**
 * Runtime file and PTY helpers for Claude sessions.
 * Implements PRD §4, §6, and §9.
 */

import { resolve } from "node:path";
import { bridgeScriptSource } from "../bridge/script.ts";
import * as activity from "../core/activity.ts";
import { AttentionWatcher } from "../core/attention.ts";
import { causeDetails, elwoodError } from "../core/errors.ts";
import { TurnStateWatcher } from "../core/turn-state.ts";
import type {
  ElwoodEventHandler,
  ElwoodEventName,
  StartClaudeOptions,
  TerminalSize,
} from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit, PtyProcess } from "../pty/types.ts";
import { currentPtyFactory } from "../runtime/seams.ts";
import { finishSessionExit } from "../runtime/session-exit.ts";
import { userShell } from "../runtime/shell.ts";
import { writePrivateFileAtomic } from "../state/files.ts";
import type { SessionRecord } from "../state/store.ts";
import { buildClaudeShellCommand, shellLaunch } from "./command.ts";
import { claudeScreenFactTableForTrustPolicy } from "./screen-table.ts";
import { generateClaudeSettings } from "./settings.ts";

/** The rendered-frame observers (turn/attention/screen-fact) for a Claude session. */
export function buildClaudeObservers(
  elwoodSessionId: string,
  autotrust: boolean,
  emitter: TypedEmitter,
) {
  return {
    turn: new TurnStateWatcher(),
    attention: new AttentionWatcher(),
    table: claudeScreenFactTableForTrustPolicy(autotrust),
    agent: "claude" as const,
    elwoodSessionId,
    emitActivity: (event: activity.ElwoodActivityEvent) => emitter.emit("activity", event),
  };
}

export function writeRuntimeFiles(
  record: SessionRecord,
  token: string,
  options: StartClaudeOptions,
): void {
  writePrivateFileAtomic(
    record.paths.bridgeScriptPath,
    bridgeScriptSource(record.paths.socketPath, token),
  );
  const settings = generateClaudeSettings({
    bridgeScriptPath: record.paths.bridgeScriptPath,
    options,
    timeoutSeconds: Math.ceil((options.hookTimeoutMs ?? 25_000) / 1000),
  });
  writePrivateFileAtomic(record.paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function spawnClaudePty(
  record: SessionRecord,
  options: StartClaudeOptions & { readonly initialSize: TerminalSize },
): PtyProcess {
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
      size: options.initialSize,
    });
  } catch (error) {
    throw elwoodError("pty_start_failed", "Could not start Claude PTY.", causeDetails(error));
  }
}

export function registerInitialHooks(
  emitter: TypedEmitter,
  handlers: StartClaudeOptions["hooks"],
): void {
  if (!handlers) return;
  for (const [name, handler] of Object.entries(handlers)) {
    emitter.listen(`hook:${name}` as ElwoodEventName, hookHandler(name, handler));
  }
}

/**
 * Emit the terminal-exit event and its activity (PRD §5.3 C-LIFE-10). Called from
 * the PTY-exit boundary's `finally` so it always runs, even if the final transcript
 * flush threw — no missed exit event, no unpersisted terminal status.
 */
export function emitTerminalExit(
  emitter: TypedEmitter,
  elwoodSessionId: string,
  exit: PtyExit,
): void {
  emitter.emit("terminal:exit", { elwoodSessionId, ...exit });
  emitter.emit(
    "activity",
    activity.activityFromTerminalExit("claude", elwoodSessionId, exit.exitCode),
  );
}

/**
 * The PTY-exit boundary: run the bounded transcript flush, then emit `terminal:exit`
 * and submit terminal status (which reaps) behind the shared error boundary so a
 * throwing flush/listener never skips the unconditional reap (PRD §5.3 C-LIFE-10).
 */
export function handleClaudeExit(
  emitter: TypedEmitter,
  elwoodSessionId: string,
  exit: PtyExit,
  finishSafely: (afterFlush: () => void) => void,
  submitExit: () => void,
): void {
  finishSafely(() =>
    finishSessionExit(() => emitTerminalExit(emitter, elwoodSessionId, exit), submitExit),
  );
}

function hookHandler(name: string, handler: unknown): ElwoodEventHandler<ElwoodEventName> {
  if (typeof handler === "function") return handler as ElwoodEventHandler<ElwoodEventName>;
  if ((name !== "PreToolUse" && name !== "PermissionRequest") || !isRecord(handler)) {
    return () => undefined;
  }
  return ((event: unknown) => {
    const toolName =
      isRecord(event) && typeof event["tool_name"] === "string" ? event["tool_name"] : "";
    const toolHandler = handler[toolName] ?? handler["unknown"];
    return typeof toolHandler === "function" ? toolHandler(event) : undefined;
  }) as ElwoodEventHandler<ElwoodEventName>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
