/** CodexSession implementation coordinating PTY, state, and hook dispatch. Implements PRD §5.5, §5.6, §5.7, §7A, §8, and §9. */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { bridgeScriptSource } from "../bridge/script.ts";
import { HookBridgeServer } from "../bridge/server.ts";
import * as activity from "../core/activity.ts";
import { activityFromStartupPrompt } from "../core/activity.ts";
import { elwoodError } from "../core/errors.ts";
import type { TerminalSize } from "../core/types.ts";
import { TypedEmitter } from "../events/emitter.ts";
import {
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  readSessionRecord,
  type SessionRecord,
  writeSessionRecord,
} from "../state/store.ts";
import { attachPtyTerminal } from "../terminal/headless.ts";
import { isCodexBlock, requestCodexHook } from "./hook-dispatch.ts";
import type { CodexHookEvent } from "./hooks.ts";
import * as preflight from "./preflight.ts";
import { spawnCodexPty } from "./pty.ts";
import { serializeCodexHookResult } from "./serialize.ts";
import { registerInitialHooks } from "./session-hooks.ts";
import { type CodexHookBridge, CodexSessionImpl } from "./session-instance.ts";
import type {
  CodexEventMap,
  CodexSession,
  ResumeCodexOptions,
  StartCodexOptions,
} from "./session-types.ts";
import { CodexStartupPromptResponder } from "./startup-prompts.ts";
import { CodexTranscriptWatcher } from "./transcript.ts";
import { isCodexHookEvent } from "./validate.ts";

const defaultSize: TerminalSize = { cols: 189, rows: 48 };

type HookBridgeFactory = (
  socketPath: string,
  token: string,
  dispatch: ConstructorParameters<typeof HookBridgeServer>[2],
  onError: ConstructorParameters<typeof HookBridgeServer>[3],
) => CodexHookBridge;

const realHookBridgeFactory: HookBridgeFactory = (socketPath, token, dispatch, onError) =>
  new HookBridgeServer(socketPath, token, dispatch, onError, isCodexHookEvent);

let hookBridgeFactory = realHookBridgeFactory;

export function setCodexHookBridgeFactoryForTests(factory: HookBridgeFactory): void {
  hookBridgeFactory = factory;
}

export function resetCodexSessionSeamsForTests(): void {
  hookBridgeFactory = realHookBridgeFactory;
  preflight.resetCodexPreflightCacheForTests();
}

export async function startCodex(options: StartCodexOptions): Promise<CodexSession> {
  preflight.preflightCodex(options.strictVersionCheck ?? false, options.autoupdate ?? false);
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd);
  prepareStateDir(stateDir);
  const record = createSessionRecord({
    stateDir,
    cwd: options.cwd,
    id: randomUUID(),
    adapter: "codex",
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    size: options.initialSize ?? defaultSize,
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  writeSessionRecord(record);
  return await startFromRecord(record, options);
}

export async function resumeCodex(options: ResumeCodexOptions): Promise<CodexSession> {
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd ?? process.cwd());
  const record = readSessionRecord(stateDir, options.elwoodSessionId);
  if (record.adapter !== "codex") {
    throw elwoodError("adapter_mismatch", "Cannot resume a non-Codex session as Codex.");
  }
  if (!record.codex.resumeId) {
    throw elwoodError("resume_unavailable", "Cannot resume Codex without a Codex session id.");
  }
  preflight.preflightCodex(options.strictVersionCheck ?? false, options.autoupdate ?? false);
  const size = options.initialSize ?? record.terminalSize;
  return await startFromRecord(record, {
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
  options: StartCodexOptions,
): Promise<CodexSessionImpl> {
  mkdirSync(record.paths.sessionDir, { recursive: true });
  const token = randomUUID();
  writeFileSync(record.paths.bridgeScriptPath, bridgeScriptSource(record.paths.socketPath, token));
  const emitter = new TypedEmitter<CodexEventMap>();
  registerInitialHooks(emitter, options.hooks);
  const transcriptWatcher = new CodexTranscriptWatcher(record.elwoodSessionId, (event) => {
    emitter.emit("codex:transcript", event);
    emitter.emit("activity", activity.activityFromCodexTranscript(event));
  });
  let session: CodexSessionImpl | undefined;
  const bridge = hookBridgeFactory(
    record.paths.socketPath,
    token,
    async (input) => dispatchHook(input, emitter, options, record, session),
    (event) => {
      const hookError = { elwoodSessionId: record.elwoodSessionId, ...event };
      emitter.emit("hookError", hookError);
      emitter.emit("activity", activity.activityFromHookError("codex", hookError));
    },
  );
  try {
    await bridge.start();
  } catch (error) {
    throw elwoodError("hook_bridge_failed", "Could not start Elwood hook bridge.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const pty = spawnCodexPty(record, options);
  const promptResponder = new CodexStartupPromptResponder(record.elwoodSessionId);
  const terminal = attachPtyTerminal(
    options.initialSize ?? record.terminalSize ?? defaultSize,
    pty,
    (data, renderedTerminal) => {
      const result = promptResponder.handle(renderedTerminal.snapshot().text, (input) =>
        renderedTerminal.sendInput(input),
      );
      session?.recordWarnings(result.warnings);
      for (const automation of result.automations)
        emitter.emit(
          "activity",
          activityFromStartupPrompt(record.elwoodSessionId, automation.prompt, automation.input),
        );
      emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
    },
  );
  session = new CodexSessionImpl(record, pty, terminal, bridge, emitter, transcriptWatcher);
  pty.onExit((exit) => {
    emitter.emit("terminal:exit", { elwoodSessionId: record.elwoodSessionId, ...exit });
    emitter.emit(
      "activity",
      activity.activityFromTerminalExit("codex", record.elwoodSessionId, exit.exitCode),
    );
    session?.markExited();
  });
  session.markRunning();
  return session;
}

async function dispatchHook(
  input: unknown,
  emitter: TypedEmitter<CodexEventMap>,
  options: StartCodexOptions,
  record: SessionRecord,
  session?: CodexSessionImpl,
) {
  const event = input as CodexHookEvent;
  session?.observeTranscript(event.transcript_path);
  if (event.hook_event_name === "SessionStart") session?.rememberCodexSessionId(event.session_id);
  emitter.emit("hook", event);
  emitter.emit("activity", activity.activityFromHook("codex", record.elwoodSessionId, event));
  const result = await requestCodexHook(
    emitter,
    event,
    options.hookTimeoutMs ?? 25_000,
    record.elwoodSessionId,
  );
  if (event.hook_event_name === "Stop" && !isCodexBlock(result)) session?.markReady();
  return serializeCodexHookResult(event.hook_event_name, result);
}
