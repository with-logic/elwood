/** ClaudeSession implementation coordinating PTY, state, and hook dispatch. Implements PRD §5, §6, §8, and §9. */
import { randomUUID } from "node:crypto";
import { defaultTerminalSize } from "../core/defaults.ts";
import { causeDetails, elwoodError } from "../core/errors.ts";
import { queuePersonaMessage } from "../core/persona.ts";
import { observeRenderedFrame } from "../core/rendered-observers.ts";
import { emitStartupPromptActivities } from "../core/startup-automation.ts";
import { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { StartClaudeOptions } from "../core/types.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit } from "../pty/types.ts";
import { initialReady } from "../runtime/initial-ready.ts";
import { assertStartupUsable } from "../runtime/startup.ts";
import { cleanupStartupResources, guardStartupRegion } from "../runtime/startup-cleanup.ts";
import { secureMkdir } from "../state/files.ts";
import { claudeLaunchPosture, withClaudeLaunch } from "../state/launch-posture.ts";
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
import { preflightClaude } from "./preflight.ts";
import {
  currentClaudeHookBridgeFactory,
  resetClaudeHookBridgeFactoryForTests,
  setHookBridgeFactoryForTests,
} from "./session-bridge.ts";
import { buildClaudeHookErrorHandler, buildClaudeHookHandler } from "./session-hook-handler.ts";
import { ClaudeSessionImpl } from "./session-instance.ts";
import type { ClaudeSession } from "./session-interface.ts";
import {
  buildClaudeObservers,
  handleClaudeExit,
  registerInitialHooks,
  spawnClaudePty,
  writeRuntimeFiles,
} from "./session-runtime.ts";
import {
  createTranscriptWatcher,
  observeTranscript,
  transcriptSeedFromWarnings,
} from "./session-transcript.ts";
import { ClaudeStartupPromptResponder } from "./startup-prompts.ts";

const CLAUDE_STARTUP_MIN_COLS = 100;

export {
  resetClaudeHookBridgeFactoryForTests as resetClaudeSessionSeamsForTests,
  setHookBridgeFactoryForTests,
};
export async function startClaude(options: StartClaudeOptions): Promise<ClaudeSession> {
  const strict = options.strictVersionCheck ?? false;
  const warning = await preflightClaude(strict, options.autoupdate ?? false);
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
  const posture = withClaudeLaunch(createdRecord, claudeLaunchPosture(options));
  const record =
    warning === undefined
      ? posture
      : upsertSessionWarning(posture, { elwoodSessionId: posture.elwoodSessionId, ...warning })
          .record;
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
  // Seed continues a resumed session's running drop/read-error counts, not 0 (§5.4).
  const seed = transcriptSeedFromWarnings(record.warnings);
  const wired = createTranscriptWatcher(record.elwoodSessionId, emitter, () => session, seed);
  const { watcher: transcriptWatcher, flushPendingWarnings, finishSafely } = wired;
  // Initial readiness is hook-backed (`InstructionsLoaded` fires `mark`); the first
  // rendered frame only arms a starvation deadline so a missing or failed hook
  // bridge cannot leave queued persona/messages starved forever (PRD §5.3, C-API-28).
  // The callback is one-shot (idempotent), so a late deadline after the hook is a no-op.
  const ready = initialReady(() => {
    turnWatcher.arm();
    session?.initialized();
    session?.submitEvidence("initial_ready");
  });
  const bridge = currentClaudeHookBridgeFactory()(
    record.paths.socketPath,
    record.bridgeToken,
    record.elwoodSessionId,
    buildClaudeHookHandler({
      record,
      options,
      emitter,
      transcriptWatcher,
      ready,
      getSession: () => session,
      getTurnWatcher: () => turnWatcher,
      observeHookTranscript: (event) => observeTranscript(transcriptWatcher, event),
    }),
    buildClaudeHookErrorHandler(record, emitter),
  );
  try {
    await bridge.start();
  } catch (error) {
    throw elwoodError("hook_bridge_failed", "Could not start Elwood hook bridge.", {
      ...causeDetails(error),
      socketPath: record.paths.socketPath,
    });
  }
  const requestedSize = options.initialSize ?? record.terminalSize ?? defaultTerminalSize;
  const startupSize = {
    ...requestedSize,
    cols: Math.max(requestedSize.cols, CLAUDE_STARTUP_MIN_COLS),
  };
  let pty: ReturnType<typeof spawnClaudePty>;
  try {
    pty = spawnClaudePty(record, { ...options, initialSize: startupSize });
  } catch (error) {
    await cleanupStartupResources({ bridge });
    throw error;
  }
  let startupOutput = "";
  let startupExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  const autotrust = options.autotrust ?? false;
  const promptResponder = new ClaudeStartupPromptResponder(autotrust);
  const observers = buildClaudeObservers(record.elwoodSessionId, autotrust, emitter);
  const turnWatcher = observers.turn;
  const terminal = attachPtyTerminal(startupSize, pty, (data, renderedTerminal) => {
    startupOutput += data;
    terminalReplay.push(data);
    const frame = { text: renderedTerminal.snapshot().text, title: renderedTerminal.title };
    const autos = promptResponder.handle(frame.text, (i) => renderedTerminal.sendInput(i));
    emitStartupPromptActivities(emitter, "claude", record.elwoodSessionId, autos);
    // Readiness is hook-backed (`InstructionsLoaded` fires it); the frame only
    // arms the starvation-deadline fallback so a missing/failed hook bridge
    // cannot starve the queue forever (C-API-28, see initial-ready.ts).
    ready.armDeadline();
    observeRenderedFrame(observers, frame, session);
    emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
  });
  session = new ClaudeSessionImpl(
    record,
    pty,
    terminal,
    bridge,
    emitter,
    terminalReplay,
    requestedSize,
  );
  const active = session;
  // ONE guarded region for every live-resource step after the session exists (flush,
  // exit registration, startup assertion, startup evidence): a failure in ANY of them
  // tears down the now-live PTY, bridge, terminal, and watcher first (PRD §9.1, §9.4).
  await guardStartupRegion(
    async () => {
      flushPendingWarnings(); // sink now exists: flush any early-buffered diagnostic (§5.7)
      // A hook or deadline that fired before the session existed submitted nothing
      // (evidence is `session?.`-guarded); replay it now the session can consume it.
      ready.replay();
      pty.onExit((exit) => {
        startupExit = exit;
        ready.cancel(); // No queued message can release after exit; drop the pending deadline.
        handleClaudeExit(emitter, record.elwoodSessionId, exit, finishSafely, () =>
          active.submitExit(),
        );
      });
      await assertStartupUsable({
        adapter: "claude",
        exit: () => startupExit,
        output: () => startupOutput,
      });
      active.submitEvidence("startup_usable");
    },
    { before: () => ready.cancel(), pty, bridge, terminal, after: () => transcriptWatcher.stop() },
  );
  return session;
}
