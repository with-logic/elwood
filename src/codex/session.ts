/** CodexSession implementation coordinating PTY, state, and hook dispatch. Implements PRD §5.5, §5.6, §5.7, §7A, §8, and §9. */
import { randomUUID } from "node:crypto";
import { bridgeScriptSource } from "../bridge/script.ts";
import * as activity from "../core/activity.ts";
import { defaultTerminalSize } from "../core/defaults.ts";
import { elwoodError } from "../core/errors.ts";
import { emitStartupPromptActivity } from "../core/startup-automation.ts";
import { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit } from "../pty/types.ts";
import { assertStartupUsable } from "../runtime/startup.ts";
import { secureMkdir, writePrivateFile } from "../state/files.ts";
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
import * as preflight from "./preflight.ts";
import { spawnCodexPty } from "./pty.ts";
import {
  currentCodexHookBridgeFactory,
  resetCodexSessionSeamsForTests,
  setCodexHookBridgeFactoryForTests,
} from "./session-bridge.ts";
import { dispatchHook, registerInitialHooks } from "./session-hooks.ts";
import { CodexSessionImpl } from "./session-instance.ts";
import type {
  CodexEventMap,
  CodexSession,
  ResumeCodexOptions,
  StartCodexOptions,
} from "./session-types.ts";
import { CodexStartupPromptResponder } from "./startup-prompts.ts";
import { CodexTranscriptWatcher } from "./transcript.ts";

export { resetCodexSessionSeamsForTests, setCodexHookBridgeFactoryForTests };
export async function startCodex(options: StartCodexOptions): Promise<CodexSession> {
  const warning = preflight.preflightCodex(
    options.strictVersionCheck ?? false,
    options.autoupdate ?? false,
  );
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd);
  prepareStateDir(stateDir, { gitignore: options.stateDir === undefined });
  const createdRecord = createSessionRecord({
    stateDir,
    cwd: options.cwd,
    id: randomUUID(),
    adapter: "codex",
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
export async function resumeCodex(options: ResumeCodexOptions): Promise<CodexSession> {
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd ?? process.cwd());
  const record = readSessionRecord(stateDir, options.elwoodSessionId);
  if (record.adapter !== "codex") {
    throw elwoodError("adapter_mismatch", "Cannot resume a non-Codex session as Codex.");
  }
  if (!record.codex.resumeId) {
    throw elwoodError("resume_unavailable", "Cannot resume Codex without a Codex session id.");
  }
  const warning = preflight.preflightCodex(
    options.strictVersionCheck ?? false,
    options.autoupdate ?? false,
  );
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
async function startFromRecord(record: SessionRecord, options: StartCodexOptions) {
  secureMkdir(record.paths.sessionDir);
  writePrivateFile(
    record.paths.bridgeScriptPath,
    bridgeScriptSource(record.paths.socketPath, record.bridgeToken),
  );
  const emitter = new TypedEmitter<CodexEventMap>();
  registerInitialHooks(emitter, options.hooks);
  const transcriptWatcher = new CodexTranscriptWatcher(record.elwoodSessionId, (event) => {
    emitter.emit("codex:transcript", event);
    emitter.emit("activity", activity.activityFromCodexTranscript(event));
  });
  let session: CodexSessionImpl | undefined;
  const bridge = currentCodexHookBridgeFactory()(
    record.paths.socketPath,
    record.bridgeToken,
    record.elwoodSessionId,
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
  let pty: ReturnType<typeof spawnCodexPty>;
  try {
    pty = spawnCodexPty(record, options);
  } catch (error) {
    await bridge.stop();
    throw error;
  }
  let startupOutput = "";
  let startupExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  const promptResponder = new CodexStartupPromptResponder(
    record.elwoodSessionId,
    options.autotrust ?? false,
  );
  const terminal = attachPtyTerminal(
    options.initialSize ?? record.terminalSize ?? defaultTerminalSize,
    pty,
    (data, renderedTerminal) => {
      startupOutput += data;
      terminalReplay.push(data);
      const result = promptResponder.handle(renderedTerminal.snapshot().text, (input) =>
        renderedTerminal.sendInput(input),
      );
      session?.recordWarnings(result.warnings);
      for (const automation of result.automations) {
        emitStartupPromptActivity(emitter, "codex", record.elwoodSessionId, automation);
      }
      emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
    },
  );
  session = new CodexSessionImpl(
    record,
    pty,
    terminal,
    bridge,
    emitter,
    terminalReplay,
    transcriptWatcher,
  );
  pty.onExit((exit) => {
    startupExit = exit;
    emitter.emit("terminal:exit", { elwoodSessionId: record.elwoodSessionId, ...exit });
    emitter.emit(
      "activity",
      activity.activityFromTerminalExit("codex", record.elwoodSessionId, exit.exitCode),
    );
    session?.markExited();
  });
  try {
    await assertStartupUsable({
      adapter: "codex",
      exit: () => startupExit,
      output: () => startupOutput,
    });
  } catch (error) {
    pty.kill("SIGTERM");
    await bridge.stop();
    transcriptWatcher.stop();
    terminal.dispose();
    throw error;
  }
  session.markRunning();
  return session;
}
