/** ClaudeSession implementation coordinating PTY, state, and hook dispatch. Implements PRD §5, §6, §8, and §9. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { HookBridgeServer } from "../bridge/server.ts";
import * as activity from "../core/activity.ts";
import { elwoodError } from "../core/errors.ts";
import type {
  ClaudeSession,
  ResumeClaudeOptions,
  StartClaudeOptions,
  TerminalSize,
} from "../core/types.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit } from "../pty/types.ts";
import { assertStartupUsable } from "../runtime/startup.ts";
import {
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
import { ClaudeSessionImpl, type HookBridge } from "./session-instance.ts";
import { registerInitialHooks, spawnClaudePty, writeRuntimeFiles } from "./session-runtime.ts";

const defaultSize: TerminalSize = { cols: 189, rows: 48 };

type HookBridgeFactory = (
  socketPath: string,
  token: string,
  dispatch: ConstructorParameters<typeof HookBridgeServer>[2],
  onError: ConstructorParameters<typeof HookBridgeServer>[3],
) => HookBridge;

const realHookBridgeFactory: HookBridgeFactory = (socketPath, token, dispatch, onError) =>
  new HookBridgeServer(socketPath, token, dispatch, onError);

let hookBridgeFactory = realHookBridgeFactory;

export function setHookBridgeFactoryForTests(factory: HookBridgeFactory): void {
  hookBridgeFactory = factory;
}

export function resetClaudeSessionSeamsForTests(): void {
  hookBridgeFactory = realHookBridgeFactory;
}

export async function startClaude(options: StartClaudeOptions): Promise<ClaudeSession> {
  preflightClaude(options.strictVersionCheck ?? false, options.autoupdate ?? false);
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd);
  prepareStateDir(stateDir);
  const record = createSessionRecord({
    stateDir,
    cwd: options.cwd,
    id: randomUUID(),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    size: options.initialSize ?? defaultSize,
    ...(options.name === undefined ? {} : { name: options.name }),
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
  preflightClaude(options.strictVersionCheck ?? false, options.autoupdate ?? false);
  const size = options.initialSize ?? record.terminalSize;
  const resumedRecord =
    options.initialSize === undefined ? record : { ...record, terminalSize: options.initialSize };
  writeSessionRecord(resumedRecord);
  return await startFromRecord(resumedRecord, {
    cwd: options.cwd ?? record.cwd,
    stateDir,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(size === undefined ? {} : { initialSize: size }),
    ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
    ...(options.strictVersionCheck === undefined
      ? {}
      : { strictVersionCheck: options.strictVersionCheck }),
  });
}

async function startFromRecord(
  record: SessionRecord,
  options: StartClaudeOptions,
): Promise<ClaudeSessionImpl> {
  mkdirSync(record.paths.sessionDir, { recursive: true });
  const token = randomUUID();
  writeRuntimeFiles(record, token, options);
  const emitter = new TypedEmitter();
  registerInitialHooks(emitter, options.hooks);
  let session: ClaudeSessionImpl | undefined;
  const bridge = hookBridgeFactory(
    record.paths.socketPath,
    token,
    async (input) => {
      const event = input as ClaudeHookEvent;
      if (event.hook_event_name === "SessionStart") {
        session?.rememberClaudeSessionId(event.session_id);
      }
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
  const pty = spawnClaudePty(record, options);
  let startupOutput = "";
  let startupExit: PtyExit | undefined;
  const terminal = attachPtyTerminal(
    options.initialSize ?? record.terminalSize ?? defaultSize,
    pty,
    (data) => {
      startupOutput += data;
      emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
    },
  );
  session = new ClaudeSessionImpl(record, pty, terminal, bridge, emitter);
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
