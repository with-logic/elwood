/** ClaudeSession implementation coordinating PTY, state, and hook dispatch. Implements PRD §5, §6, §8, and §9. */
import { randomUUID } from "node:crypto";
import * as activity from "../core/activity.ts";
import { defaultTerminalSize } from "../core/defaults.ts";
import { elwoodError } from "../core/errors.ts";
import { emitStartupPromptActivity } from "../core/startup-automation.ts";
import { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { ClaudeSession, ResumeClaudeOptions, StartClaudeOptions } from "../core/types.ts";
import { WorkspaceTrustResponder } from "../core/workspace-trust.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit } from "../pty/types.ts";
import { assertStartupUsable } from "../runtime/startup.ts";
import { secureMkdir } from "../state/files.ts";
import {
  appendSessionWarning,
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  readSessionRecord,
  type SessionRecord,
  writeSessionRecord,
} from "../state/store.ts";
import { attachPtyTerminal } from "../terminal/headless.ts";
import { isBlock, requestHook } from "./hook-dispatch.ts";
import type { ClaudeHookEvent } from "./hooks.ts";
import { preflightClaude } from "./preflight.ts";
import { serializeHookResult } from "./serialize.ts";
import {
  currentClaudeHookBridgeFactory,
  resetClaudeHookBridgeFactoryForTests,
  setHookBridgeFactoryForTests,
} from "./session-bridge.ts";
import { ClaudeSessionImpl } from "./session-instance.ts";
import { registerInitialHooks, spawnClaudePty, writeRuntimeFiles } from "./session-runtime.ts";

export { setHookBridgeFactoryForTests };

export function resetClaudeSessionSeamsForTests(): void {
  resetClaudeHookBridgeFactoryForTests();
}

export async function startClaude(options: StartClaudeOptions): Promise<ClaudeSession> {
  const warning = preflightClaude(options.strictVersionCheck ?? false, options.autoupdate ?? false);
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd);
  prepareStateDir(stateDir, { gitignore: options.stateDir === undefined });
  const createdRecord = createSessionRecord({
    stateDir,
    cwd: options.cwd,
    id: randomUUID(),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    size: options.initialSize ?? defaultTerminalSize,
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  const record =
    warning === undefined
      ? createdRecord
      : appendSessionWarning(createdRecord, {
          elwoodSessionId: createdRecord.elwoodSessionId,
          ...warning,
        });
  writeSessionRecord(record);
  return await startFromRecord(record, options);
}

export async function resumeClaude(options: ResumeClaudeOptions): Promise<ClaudeSession> {
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd ?? process.cwd());
  const record = readSessionRecord(stateDir, options.elwoodSessionId);
  if (record.adapter !== "claude") {
    throw elwoodError("adapter_mismatch", "Cannot resume a non-Claude session as Claude.");
  }
  if (!record.claude.resumeId) {
    throw elwoodError("resume_unavailable", "Cannot resume Claude without a Claude session id.");
  }
  const warning = preflightClaude(options.strictVersionCheck ?? false, options.autoupdate ?? false);
  const checkedRecord =
    warning === undefined
      ? record
      : appendSessionWarning(record, { elwoodSessionId: record.elwoodSessionId, ...warning });
  const size = options.initialSize ?? checkedRecord.terminalSize;
  const resumedRecord =
    options.initialSize === undefined
      ? checkedRecord
      : { ...checkedRecord, terminalSize: options.initialSize };
  writeSessionRecord(resumedRecord);
  return await startFromRecord(resumedRecord, {
    cwd: options.cwd ?? record.cwd,
    stateDir,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(size === undefined ? {} : { initialSize: size }),
    ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
    ...(options.autotrust === undefined ? {} : { autotrust: options.autotrust }),
    ...(options.strictVersionCheck === undefined
      ? {}
      : { strictVersionCheck: options.strictVersionCheck }),
  });
}

async function startFromRecord(record: SessionRecord, options: StartClaudeOptions) {
  secureMkdir(record.paths.sessionDir);
  writeRuntimeFiles(record, record.bridgeToken, options);
  const emitter = new TypedEmitter();
  registerInitialHooks(emitter, options.hooks);
  let session: ClaudeSessionImpl | undefined;
  const bridge = currentClaudeHookBridgeFactory()(
    record.paths.socketPath,
    record.bridgeToken,
    record.elwoodSessionId,
    async (input) => {
      const event = input as ClaudeHookEvent;
      if (event.hook_event_name === "SessionStart")
        session?.rememberClaudeSessionId(event.session_id);
      emitter.emit("hook", event);
      emitter.emit("activity", activity.activityFromHook("claude", record.elwoodSessionId, event));
      const outcome = await requestHook(
        emitter,
        event,
        options.hookTimeoutMs ?? 25_000,
        record.elwoodSessionId,
      );
      emitter.emit(
        "activity",
        activity.activityFromHookResult(
          "claude",
          record.elwoodSessionId,
          event.hook_event_name,
          outcome.result,
          outcome.failedOpen,
        ),
      );
      if (event.hook_event_name === "Stop" && !isBlock(outcome.result)) {
        session?.markReady();
      }
      return serializeHookResult(event.hook_event_name, outcome.result);
    },
    (event) => {
      const hookError = { elwoodSessionId: record.elwoodSessionId, ...event };
      emitter.emit("hookError", hookError);
      emitter.emit("activity", activity.activityFromHookError("claude", hookError));
    },
  );
  try {
    await bridge.start();
  } catch (error) {
    throw elwoodError("hook_bridge_failed", "Could not start Elwood hook bridge.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  let pty: ReturnType<typeof spawnClaudePty>;
  try {
    pty = spawnClaudePty(record, options);
  } catch (error) {
    await bridge.stop();
    throw error;
  }
  let startupOutput = "";
  let startupExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  const workspaceTrust = new WorkspaceTrustResponder("claude", options.autotrust ?? false);
  const terminal = attachPtyTerminal(
    options.initialSize ?? record.terminalSize ?? defaultTerminalSize,
    pty,
    (data, renderedTerminal) => {
      startupOutput += data;
      terminalReplay.push(data);
      const trust = workspaceTrust.handle(renderedTerminal.snapshot().text, (input) =>
        renderedTerminal.sendInput(input),
      );
      if (trust) emitStartupPromptActivity(emitter, "claude", record.elwoodSessionId, trust);
      emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
    },
  );
  session = new ClaudeSessionImpl(record, pty, terminal, bridge, emitter, terminalReplay);
  pty.onExit((exit) => {
    startupExit = exit;
    emitter.emit("terminal:exit", { elwoodSessionId: record.elwoodSessionId, ...exit });
    emitter.emit(
      "activity",
      activity.activityFromTerminalExit("claude", record.elwoodSessionId, exit.exitCode),
    );
    session?.markExited();
  });
  try {
    await assertStartupUsable({
      adapter: "claude",
      exit: () => startupExit,
      output: () => startupOutput,
    });
  } catch (error) {
    pty.kill("SIGTERM");
    await bridge.stop();
    terminal.dispose();
    throw error;
  }
  session.markRunning();
  return session;
}
