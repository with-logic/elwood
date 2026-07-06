/** ClaudeSession implementation coordinating PTY, state, and hook dispatch. Implements PRD §5, §6, §8, and §9. */
import { randomUUID } from "node:crypto";
import * as activity from "../core/activity.ts";
import { defaultTerminalSize } from "../core/defaults.ts";
import { causeDetails, elwoodError } from "../core/errors.ts";
import { queuePersonaMessage } from "../core/persona.ts";
import { emitStartupPromptActivity } from "../core/startup-automation.ts";
import { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { ClaudeSession, StartClaudeOptions } from "../core/types.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit } from "../pty/types.ts";
import { assertStartupUsable } from "../runtime/startup.ts";
import { cleanupStartupResources } from "../runtime/startup-cleanup.ts";
import { secureMkdir } from "../state/files.ts";
import {
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  type SessionRecord,
  upsertSessionWarning,
  withFreshSocketPath,
  writeSessionRecord,
} from "../state/store.ts";
import { attachPtyTerminal } from "../terminal/headless.ts";
import { isBlock, requestHook } from "./hook-dispatch.ts";
import { normalizeClaudeHookEvent } from "./normalize.ts";
import { preflightClaude } from "./preflight.ts";
import { serializeHookResult } from "./serialize.ts";
import {
  currentClaudeHookBridgeFactory,
  resetClaudeHookBridgeFactoryForTests,
  setHookBridgeFactoryForTests,
} from "./session-bridge.ts";
import { ClaudeSessionImpl } from "./session-instance.ts";
import { registerInitialHooks, spawnClaudePty, writeRuntimeFiles } from "./session-runtime.ts";
import { ClaudeStartupPromptResponder } from "./startup-prompts.ts";

export {
  resetClaudeHookBridgeFactoryForTests as resetClaudeSessionSeamsForTests,
  setHookBridgeFactoryForTests,
};
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
      : upsertSessionWarning(createdRecord, {
          elwoodSessionId: createdRecord.elwoodSessionId,
          ...warning,
        }).record;
  writeSessionRecord(record);
  return queuePersonaMessage(await startClaudeFromRecord(record, options), options.persona);
}

export async function startClaudeFromRecord(
  storedRecord: SessionRecord,
  options: StartClaudeOptions,
) {
  const record = withFreshSocketPath(storedRecord);
  secureMkdir(record.paths.sessionDir);
  writeSessionRecord(record);
  writeRuntimeFiles(record, record.bridgeToken, options);
  const emitter = new TypedEmitter();
  registerInitialHooks(emitter, options.hooks);
  let session: ClaudeSessionImpl | undefined;
  let initialReadyMarked = false;
  const bridge = currentClaudeHookBridgeFactory()(
    record.paths.socketPath,
    record.bridgeToken,
    record.elwoodSessionId,
    async (input) => {
      const event = normalizeClaudeHookEvent(input);
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
      if (event.hook_event_name === "InstructionsLoaded" && !initialReadyMarked) {
        initialReadyMarked = true;
        session?.markReady();
      }
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
      ...causeDetails(error),
      socketPath: record.paths.socketPath,
    });
  }
  let pty: ReturnType<typeof spawnClaudePty>;
  try {
    pty = spawnClaudePty(record, options);
  } catch (error) {
    await cleanupStartupResources({ bridge });
    throw error;
  }
  let startupOutput = "";
  let startupExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  const promptResponder = new ClaudeStartupPromptResponder(options.autotrust ?? false);
  const terminal = attachPtyTerminal(
    options.initialSize ?? record.terminalSize ?? defaultTerminalSize,
    pty,
    (data, renderedTerminal) => {
      startupOutput += data;
      terminalReplay.push(data);
      const automations = promptResponder.handle(renderedTerminal.snapshot().text, (input) =>
        renderedTerminal.sendInput(input),
      );
      for (const automation of automations) {
        emitStartupPromptActivity(emitter, "claude", record.elwoodSessionId, automation);
      }
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
    await cleanupStartupResources({ pty, bridge, terminal });
    throw error;
  }
  session.markRunning();
  return session;
}
