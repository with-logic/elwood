/** CodexSession implementation coordinating PTY, state, and hook dispatch. Implements PRD §5.5, §5.6, §5.7, §7A, §8, and §9. */
import { randomUUID } from "node:crypto";
import * as activity from "../core/activity.ts";
import { AttentionWatcher } from "../core/attention.ts";
import { defaultTerminalSize } from "../core/defaults.ts";
import { causeDetails, elwoodError } from "../core/errors.ts";
import { queuePersonaMessage } from "../core/persona.ts";
import { observeRenderedFrame } from "../core/rendered-observers.ts";
import { emitStartupPromptActivity } from "../core/startup-automation.ts";
import { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import { TurnStateWatcher } from "../core/turn-state.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit } from "../pty/types.ts";
import { assertStartupUsable } from "../runtime/startup.ts";
import { cleanupStartupResources } from "../runtime/startup-cleanup.ts";
import { secureMkdir } from "../state/files.ts";
import { codexLaunchPosture, withCodexLaunch } from "../state/launch-posture.ts";
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
import { initialReady } from "./initial-ready.ts";
import * as preflight from "./preflight.ts";
import { spawnCodexPty } from "./pty.ts";
import { codexComposerVisible, codexScreenFactTableForTrustPolicy } from "./screen-table.ts";
import { currentCodexHookBridgeFactory } from "./session-bridge.ts";
import { dispatchHook, registerInitialHooks } from "./session-hooks.ts";
import { CodexSessionImpl } from "./session-instance.ts";
import { writeCodexRuntimeFiles } from "./session-runtime.ts";
import type { CodexEventMap, CodexSession, StartCodexOptions } from "./session-types.ts";
import { CodexStartupPromptResponder } from "./startup-prompts.ts";
import { CodexTranscriptWatcher } from "./transcript.ts";

export {
  resetCodexSessionSeamsForTests,
  setCodexHookBridgeFactoryForTests,
} from "./session-bridge.ts";
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
  const posture = withCodexLaunch(createdRecord, codexLaunchPosture(options));
  const record =
    warning === undefined
      ? posture
      : upsertSessionWarning(posture, {
          elwoodSessionId: posture.elwoodSessionId,
          ...warning,
        }).record;
  writeSessionRecord(record);
  return queuePersonaMessage(await startCodexFromRecord(record, options), options.persona);
}
export async function startCodexFromRecord(
  storedRecord: SessionRecord,
  options: StartCodexOptions,
) {
  const record = withFreshSocketPath(storedRecord);
  secureMkdir(record.paths.sessionDir);
  writeSessionRecord(record);
  writeCodexRuntimeFiles(record);
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
      ...causeDetails(error),
      socketPath: record.paths.socketPath,
    });
  }
  let pty: ReturnType<typeof spawnCodexPty>;
  try {
    pty = spawnCodexPty(record, options);
  } catch (error) {
    await cleanupStartupResources({ bridge });
    throw error;
  }
  let startupOutput = "";
  let startupExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  const ready = initialReady(() => {
    turnWatcher.arm();
    session?.submitEvidence("initial_ready");
  });
  const autotrust = options.autotrust ?? false;
  const observers = {
    turn: new TurnStateWatcher(),
    attention: new AttentionWatcher(),
    table: codexScreenFactTableForTrustPolicy(autotrust),
    agent: "codex" as const,
    elwoodSessionId: record.elwoodSessionId,
    emitActivity: (event: activity.ElwoodActivityEvent) => emitter.emit("activity", event),
  };
  const turnWatcher = observers.turn;
  const promptResponder = new CodexStartupPromptResponder(record.elwoodSessionId, autotrust);
  const terminal = attachPtyTerminal(
    options.initialSize ?? record.terminalSize ?? defaultTerminalSize,
    pty,
    (data, renderedTerminal) => {
      startupOutput += data;
      terminalReplay.push(data);
      // One snapshot per render: reused for prompt automation, readiness, and
      // detection (input written here only repaints on the next callback).
      const frame = { text: renderedTerminal.snapshot().text, title: renderedTerminal.title };
      const result = promptResponder.handle(frame.text, (input) =>
        renderedTerminal.sendInput(input),
      );
      session?.recordWarnings(result.warnings);
      for (const automation of result.automations) {
        emitStartupPromptActivity(emitter, "codex", record.elwoodSessionId, automation);
      }
      ready.armDeadline();
      // Frame-quiet alone can fire during a boot gap before the TUI accepts
      // input (a submitted message would be swallowed); require the composer.
      if (result.automations.length === 0 && codexComposerVisible(frame.text)) ready.schedule();
      observeRenderedFrame(observers, frame, session);
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
  ready.replay();
  pty.onExit((exit) => {
    startupExit = exit;
    ready.cancel();
    transcriptWatcher.finish();
    emitter.emit("terminal:exit", { elwoodSessionId: record.elwoodSessionId, ...exit });
    emitter.emit(
      "activity",
      activity.activityFromTerminalExit("codex", record.elwoodSessionId, exit.exitCode),
    );
    session?.submitExit();
  });
  try {
    await assertStartupUsable({
      adapter: "codex",
      exit: () => startupExit,
      output: () => startupOutput,
    });
  } catch (error) {
    await cleanupStartupResources({
      before: () => ready.cancel(),
      pty,
      bridge,
      terminal,
      after: () => transcriptWatcher.stop(),
    });
    throw error;
  }
  session.submitEvidence("startup_usable");
  return session;
}
