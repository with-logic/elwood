/**
 * Runtime file and PTY helpers for Claude sessions.
 * Implements PRD §4, §6, and §9.
 */

import { resolve } from "node:path";
import { bridgeScriptSource } from "../../bridge/script.ts";
import * as activity from "../../core/activity/index.ts";
import { AttentionWatcher } from "../../core/attention.ts";
import { causeDetails, elwoodError } from "../../core/errors.ts";
import { isRecord } from "../../core/predicates.ts";
import { TurnStateWatcher } from "../../core/turn-state.ts";
import type {
  ClaudeEventMap,
  ElwoodEventHandler,
  ElwoodEventName,
  StartClaudeOptions,
  TerminalSize,
} from "../../core/types.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { PtyExit, PtyProcess } from "../../pty/types.ts";
import { currentPtyFactory } from "../../runtime/seams.ts";
import { finishSessionExit } from "../../runtime/session/exit.ts";
import { userShell } from "../../runtime/shell.ts";
import { writePrivateFileAtomic } from "../../state/files.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import type { SessionRecord } from "../../state/store.ts";
import { buildClaudeShellCommand, shellLaunch } from "../command.ts";
import { claudeScreenFactTableForTrustPolicy } from "../screen-table.ts";
import { generateClaudeSettings } from "../settings.ts";

/** The rendered-frame observers (turn/attention/screen-fact) for a Claude session. */
export function buildClaudeObservers(
  elwoodSessionId: string,
  autotrust: boolean,
  emitter: TypedEmitter<ClaudeEventMap>,
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

export function writeRuntimeFiles(runtime: SessionRuntime, options: StartClaudeOptions): void {
  writePrivateFileAtomic(
    runtime.bridgeScriptPath,
    bridgeScriptSource(runtime.socketPath, runtime.bridgeToken),
  );
  const settings = generateClaudeSettings({
    bridgeScriptPath: runtime.bridgeScriptPath,
    options,
    timeoutSeconds: cliHookTimeoutSeconds(options.hookTimeoutMs ?? 25_000),
  });
  writePrivateFileAtomic(runtime.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * The per-hook timeout written into Claude's settings. The CLI's clock starts when
 * it spawns the hook process, BEFORE the bridge connects and Elwood's own
 * `hookTimeoutMs` race begins, so an identical value would let the CLI kill the
 * hook just before Elwood's fail-open "no decision" reply arrived — turning every
 * handler timeout into a CLI-side hook failure. The margin keeps Elwood the one
 * that times out, so the parent always sees its typed `hookError` (PRD §6.3).
 */
export const cliHookTimeoutMarginSeconds = 5;

export function cliHookTimeoutSeconds(hookTimeoutMs: number): number {
  return Math.ceil(hookTimeoutMs / 1000) + cliHookTimeoutMarginSeconds;
}

export function spawnClaudePty(
  record: SessionRecord,
  settingsPath: string,
  options: StartClaudeOptions & { readonly initialSize: TerminalSize },
): PtyProcess {
  const launch = shellLaunch(
    userShell(),
    buildClaudeShellCommand(settingsPath, options, record.claude.resumeId),
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
  emitter: TypedEmitter<ClaudeEventMap>,
  handlers: StartClaudeOptions["hooks"],
): void {
  if (!handlers) return;
  for (const [name, handler] of Object.entries(handlers)) {
    emitter.listen(
      `hook:${name}` as ElwoodEventName,
      hookHandler(name, handler),
      typeof handler === "function" ? "event" : "tool-keyed",
    );
  }
}

/**
 * Emit the terminal-exit event and its activity (PRD §5.3 C-LIFE-10). Called from
 * the PTY-exit boundary's `finally` so it always runs, even if the final transcript
 * flush threw — no missed exit event.
 */
function emitTerminalExit(
  emitter: TypedEmitter<ClaudeEventMap>,
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
  emitter: TypedEmitter<ClaudeEventMap>,
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
