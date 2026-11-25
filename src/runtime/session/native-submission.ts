/** Bind physical submissions and native idle evidence to a live session (PRD §5.8/§5.9). */
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { ControlQueue } from "../../core/control-queue/index.ts";
import type { AdmitOperation, ControlSubmitter } from "../../core/control-queue/types.ts";
import { queuedInputSubmitter, type RecoveryComposer } from "../../core/input/index.ts";
import { reserveLoopSubmission } from "../../core/simple/loop-boundary.ts";
import { registerNativeIdle } from "../../core/simple/native-idle.ts";
import { observeOwnedLoop } from "../../core/simple/owned-loop.ts";
import { nativeTurnReader } from "../../core/simple/submission-context.ts";
import { captureRenderProgress } from "../../terminal/cursor.ts";
import type { SessionLifecycle } from "./lifecycle.ts";
import { notRunningError } from "./not-running.ts";
import { PasteRecoveryRevocation } from "./paste-recovery.ts";
import { type PromptNormalizer, PromptSubmissions } from "./prompt-submissions.ts";
import type { SessionInputOwnership } from "./session-input.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

export function bindNativeInput(
  session: SessionLifecycle,
  events: SessionStatusEmitter,
  readEmpty: () => object | undefined,
  submit: ControlSubmitter,
) {
  let loopEnter: ((payload: string) => void) | undefined;
  const observed = {
    get status() {
      return session.status;
    },
    on: events.on.bind(events),
  };
  registerNativeIdle(session, {
    capture: () => {
      const progressed = captureRenderProgress(session.terminal);
      const isReady = () =>
        !session.closing.signal.aborted &&
        progressed() &&
        session.status === "ready" &&
        !session.inputBlocking &&
        !session.trustInputBlocking;
      return { isReady, isIdle: () => isReady() && readEmpty() !== undefined };
    },
    // Both adapters emit terminal:data after attachPtyTerminal's completed-render observer.
    subscribe: (listener) => events.on("terminal:data", listener),
  });
  const admit: AdmitOperation = (origin, signal) => {
    if (origin.kind !== "loop") return undefined;
    const reader = nativeTurnReader(session);
    const reservation = reserveLoopSubmission(session, observed, {
      closing: session.closing.signal,
      admission: signal,
      ...(reader
        ? {
            observe: () => {
              const observer = observeOwnedLoop(session, observed, session.closing.signal, reader);
              loopEnter = observer.beforeEnter;
              return observer;
            },
          }
        : {}),
    });
    return {
      ready: reservation.ready,
      run: async (work) => {
        try {
          await reservation.submit(work);
        } finally {
          loopEnter = undefined;
        }
      },
    };
  };
  const write: ControlSubmitter = (input, mode, signal, submitted, beforeEnter) =>
    submit(input, mode, signal, submitted, (payload) => {
      loopEnter?.(payload);
      beforeEnter?.(payload);
    });
  return { admit, submit: write, readEmpty };
}

/** Create the queue and its input observers before installing any session listeners. */
export function bindSessionControl(
  session: SessionLifecycle,
  input: SessionInputOwnership,
  events: SessionStatusEmitter,
  options: {
    readonly agent: ElwoodAgentKind;
    readonly resumed: boolean;
    readonly promptNormalizer: PromptNormalizer;
    readonly blocked: () => boolean;
    readonly composer: () => RecoveryComposer;
    readonly readEmpty: () => object | undefined;
    readonly turnStarted: ConstructorParameters<typeof ControlQueue>[2];
  },
) {
  const closing = session.closing.signal;
  const prompts = options.resumed
    ? undefined
    : new PromptSubmissions(input.caller, closing, options.promptNormalizer);
  const guard = new PasteRecoveryRevocation(events, closing).createGuard(
    input.caller,
    options.composer,
    options.blocked,
    session.stopCompletion.prepareRenderedReset,
  );
  const pasteGuard = prompts?.guard(guard) ?? guard;
  const submit = queuedInputSubmitter(input.automated, pasteGuard);
  const native = bindNativeInput(session, events, options.readEmpty, submit);
  const controlQueue = new ControlQueue(
    native.submit,
    () => notRunningError(options.agent),
    options.turnStarted,
    () => session.status === "running",
    session.stopCompletion.submitted,
    input.composerCleanup(options.blocked, closing, native.readEmpty, prompts?.cleared),
    native.admit,
  );
  return { controlQueue, pasteGuard, promptSubmissions: prompts };
}
