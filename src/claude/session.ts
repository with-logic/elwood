/**
 * ClaudeSession implementation coordinating PTY, state, and hook dispatch.
 * Implements PRD §5, §6, §8, and §9.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bridgeScriptSource } from "../bridge/script.ts";
import { HookBridgeServer } from "../bridge/server.ts";
import { isClaudeHookResult } from "../bridge/validate.ts";
import { elwoodError } from "../core/errors.ts";
import type {
  ClaudeSession,
  ElwoodEventHandler,
  ElwoodEventName,
  ElwoodSessionStatus,
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
  removeSessionDir,
  type SessionRecord,
  updateSessionStatus,
  writeSessionRecord,
} from "../state/store.ts";
import { buildClaudeShellCommand, shellLaunch } from "./command.ts";
import type { ClaudeHookEvent, ClaudeHookResult } from "./hooks.ts";
import { preflightClaude } from "./preflight.ts";
import { serializeHookResult } from "./serialize.ts";
import { generateClaudeSettings } from "./settings.ts";

const defaultSize: TerminalSize = { cols: 120, rows: 40 };

type HookBridge = Pick<HookBridgeServer, "start" | "stop">;
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
  preflightClaude(options.strictVersionCheck ?? false);
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

class ClaudeSessionImpl implements ClaudeSession {
  private record: SessionRecord;
  private readonly pty: PtyProcess;
  private readonly bridge: HookBridge;
  private readonly emitter: TypedEmitter;
  private currentStatus: ElwoodSessionStatus = "starting";

  constructor(record: SessionRecord, pty: PtyProcess, bridge: HookBridge, emitter: TypedEmitter) {
    this.record = record;
    this.pty = pty;
    this.bridge = bridge;
    this.emitter = emitter;
  }

  get elwoodSessionId(): string {
    return this.record.elwoodSessionId;
  }

  get cwd(): string {
    return this.record.cwd;
  }

  get status(): ElwoodSessionStatus {
    return this.currentStatus;
  }

  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>) {
    return this.emitter.on(event, handler);
  }

  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    this.emitter.off(event, handler);
  }

  sendPrompt(prompt: string): Promise<void> {
    this.ensureRunning();
    this.pty.write(`\u001b[200~${prompt}\u001b[201~\r`);
    return Promise.resolve();
  }

  sendKeys(input: string | Uint8Array): Promise<void> {
    this.ensureRunning();
    this.pty.write(input);
    return Promise.resolve();
  }

  resize(size: TerminalSize): Promise<void> {
    this.ensureRunning();
    this.pty.resize(size);
    this.persist(updateSessionStatus({ ...this.record, terminalSize: size }, this.currentStatus));
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.pty.kill("SIGTERM");
    await this.bridge.stop();
    this.setStatus("stopped");
  }

  async kill(): Promise<void> {
    this.pty.kill("SIGKILL");
    await this.bridge.stop();
    this.setStatus("killed");
  }

  async teardown(): Promise<void> {
    await this.bridge.stop();
    removeSessionDir(this.record);
    this.currentStatus = "torn_down";
    this.emitter.emit("status", { elwoodSessionId: this.elwoodSessionId, status: "torn_down" });
  }

  markRunning(): void {
    this.setStatus("running");
  }

  markReady(): void {
    this.setStatus("ready");
  }

  markExited(): void {
    this.setStatus("exited");
  }

  private ensureRunning(): void {
    if (
      this.currentStatus === "stopped" ||
      this.currentStatus === "killed" ||
      this.currentStatus === "torn_down"
    ) {
      throw elwoodError("session_not_running", "Claude session is not running.");
    }
  }

  private setStatus(status: ElwoodSessionStatus): void {
    this.currentStatus = status;
    this.persist(updateSessionStatus(this.record, status));
    this.emitter.emit("status", { elwoodSessionId: this.elwoodSessionId, status });
  }

  private persist(record: SessionRecord): void {
    this.record = record;
    writeSessionRecord(record);
  }
}

async function startFromRecord(
  record: SessionRecord,
  options: StartClaudeOptions,
): Promise<ClaudeSessionImpl> {
  preflightClaude(options.strictVersionCheck ?? false);
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
    (event) => emitter.emit("hookError", { elwoodSessionId: record.elwoodSessionId, ...event }),
  );
  try {
    await bridge.start();
  } catch (error) {
    throw elwoodError("hook_bridge_failed", "Could not start Elwood hook bridge.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const pty = spawnClaudePty(record, options);
  session = new ClaudeSessionImpl(record, pty, bridge, emitter);
  pty.onData((data) =>
    emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data }),
  );
  pty.onExit((exit) => {
    emitter.emit("terminal:exit", { elwoodSessionId: record.elwoodSessionId, ...exit });
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

async function requestHook(
  emitter: TypedEmitter,
  event: ClaudeHookEvent,
  timeoutMs: number,
  elwoodSessionId: string,
): Promise<ClaudeHookResult> {
  try {
    const result = await withTimeout(
      emitter.request(`hook:${event.hook_event_name}` as ElwoodEventName, event),
      timeoutMs,
    );
    if (!isClaudeHookResult(event.hook_event_name, result)) {
      emitter.emit("hookError", {
        elwoodSessionId,
        hookEventName: event.hook_event_name,
        category: "invalid_response",
        message: "Hook handler returned an invalid response for this event.",
      });
      return undefined;
    }
    return result;
  } catch (error) {
    emitter.emit("hookError", {
      elwoodSessionId,
      hookEventName: event.hook_event_name,
      category: error instanceof Error && error.message === "timeout" ? "timeout" : "handler_error",
      message: error instanceof Error ? error.message : "Hook handler failed",
      timeoutMs,
    });
    return undefined;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: Timer | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isBlock(result: ClaudeHookResult): boolean {
  return Boolean(result && "decision" in result && result.decision === "block");
}
