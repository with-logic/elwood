/** ClaudeSession implementation coordinating PTY, state, and hook dispatch. Implements PRD §5, §6, §8, and §9. */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bridgeScriptSource } from "../bridge/script.ts";
import { HookBridgeServer } from "../bridge/server.ts";
import * as activity from "../core/activity.ts";
import { elwoodError } from "../core/errors.ts";
import type {
  ClaudeSession,
  ElwoodEventHandler,
  ElwoodEventName,
  ResumeClaudeOptions,
  StartClaudeOptions,
  TerminalSize,
} from "../core/types.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import { currentPtyFactory } from "../runtime/seams.ts";
import {
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  readSessionRecord,
  type SessionRecord,
  writeSessionRecord,
} from "../state/store.ts";
import { attachPtyTerminal } from "../terminal/headless.ts";
import { buildClaudeShellCommand, shellLaunch } from "./command.ts";
import { isBlock, requestHook } from "./hook-dispatch.ts";
import type { ClaudeHookEvent } from "./hooks.ts";
import { preflightClaude } from "./preflight.ts";
import { serializeHookResult } from "./serialize.ts";
import { ClaudeSessionImpl, type HookBridge } from "./session-instance.ts";
import { generateClaudeSettings } from "./settings.ts";

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
  preflightClaude(options.strictVersionCheck ?? false, options.autoupdate ?? false);
  const size = options.initialSize ?? record.terminalSize;
  const resumedRecord =
    options.initialSize === undefined ? record : { ...record, terminalSize: options.initialSize };
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
      emitter.emit("hook", event);
      emitter.emit("activity", activity.activityFromHook("claude", record.elwoodSessionId, event));
      const result = await requestHook(
        emitter,
        event,
        options.hookTimeoutMs ?? 25_000,
        record.elwoodSessionId,
      );
      if (event.hook_event_name === "Stop" && !isBlock(result)) {
        session?.markReady();
      }
      return serializeHookResult(event.hook_event_name, result);
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
  const terminal = attachPtyTerminal(
    options.initialSize ?? record.terminalSize ?? defaultSize,
    pty,
    (data) => emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data }),
  );
  session = new ClaudeSessionImpl(record, pty, terminal, bridge, emitter);
  pty.onExit((exit) => {
    emitter.emit("terminal:exit", { elwoodSessionId: record.elwoodSessionId, ...exit });
    emitter.emit(
      "activity",
      activity.activityFromTerminalExit("claude", record.elwoodSessionId, exit.exitCode),
    );
    session?.markExited();
  });
  session.markRunning();
  return session;
}

function writeRuntimeFiles(
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

function spawnClaudePty(record: SessionRecord, options: StartClaudeOptions): PtyProcess {
  const shell = process.env["SHELL"] ?? "/bin/zsh";
  const launch = shellLaunch(shell, buildClaudeShellCommand(record.paths.settingsPath, options));
  try {
    return currentPtyFactory()({
      command: launch.command,
      args: launch.args,
      cwd: resolve(options.cwd),
      env: {
        ...process.env,
        ELWOOD_SESSION_ID: record.elwoodSessionId,
      },
      size: options.initialSize ?? record.terminalSize ?? defaultSize,
    });
  } catch (error) {
    throw elwoodError("pty_start_failed", "Could not start Claude PTY.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function registerInitialHooks(emitter: TypedEmitter, handlers: StartClaudeOptions["hooks"]): void {
  if (!handlers) return;
  for (const [name, handler] of Object.entries(handlers)) {
    emitter.listen(
      `hook:${name}` as ElwoodEventName,
      handler as ElwoodEventHandler<ElwoodEventName>,
    );
  }
}
