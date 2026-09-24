/** Snapshot facade turn options before queueing (PRD §5.8, C-API-44/50). */
import type { ElwoodAgentSession } from "../agent-session.ts";
import { elwoodError } from "../errors.ts";
import type { ImageCaptures } from "../images/capture.ts";
import type { SendOptions } from "../images/types.ts";
import { personaBoundary } from "../persona.ts";
import { type ElwoodSessionStatus, terminalStatuses } from "../status-categories.ts";
import type { TurnEvent } from "./events.ts";
import { loopBoundaryTail } from "./loop-boundary.ts";
import { holdTurnLoops } from "./loop-hold.ts";
import { runTurn } from "./turn.ts";
import type { TurnQueue } from "./turn-queue.ts";
import type { BoundarySignalReader, TurnOptions } from "./turn-types.ts";

type Facade = {
  readonly status: ElwoodSessionStatus;
  readonly session?: ElwoodAgentSession | undefined;
  start(): Promise<ElwoodAgentSession>;
};

function capture<T extends SendOptions>(
  captures: ImageCaptures,
  facade: Facade,
  options: T | undefined,
) {
  if (terminalStatuses.has(facade.status))
    throw elwoodError("session_not_running", "Session is not running.");
  return captures.capture(options);
}

export function capturedTurn(
  captures: ImageCaptures,
  queue: TurnQueue,
  facade: Facade,
  readBoundarySignal: BoundarySignalReader,
  prompt: string,
  options?: TurnOptions,
): AsyncGenerator<TurnEvent> {
  let captured: { readonly options: TurnOptions | undefined; readonly release: () => void };
  try {
    captured = capture(captures, facade, options);
  } catch (error) {
    return failedTurn(error);
  }
  // Start and reserve the slot at the call, so close joins this same launch.
  let starting: Promise<ElwoodAgentSession>;
  const live = facade.session;
  // A ready listener can reserve a turn before the same transition drains due loops.
  // Install its hold synchronously when startup has already supplied a live session.
  let releaseLoopHold: () => void = live ? holdTurnLoops(live) : () => undefined;
  const release = () => {
    captured.release();
    releaseLoopHold();
  };
  try {
    starting = facade.start().then((session) => {
      if (!live) releaseLoopHold = holdTurnLoops(session);
      return session;
    });
    // Startup may reject while this reserved turn still awaits its predecessor.
    void starting.catch(() => undefined);
  } catch (error) {
    release();
    return failedTurn(error);
  }
  return queue.enqueue(async () => {
    try {
      const session = await starting;
      await personaBoundary(session);
      await loopBoundaryTail(session);
      const turn = runTurn(session, prompt, { ...captured.options, readBoundarySignal });
      void turn.boundary.then(release);
      return turn;
    } catch (error) {
      release();
      throw error;
    }
  });
}

async function* failedTurn(error: unknown): AsyncGenerator<TurnEvent> {
  yield await Promise.reject(error);
}

/** Raw facade controls capture before the lazy-start await as ergonomic turns do. */
export async function capturedSend(
  captures: ImageCaptures,
  facade: Facade,
  method: "sendPrompt" | "sendMessage" | "sendGuidance",
  input: string,
  options?: SendOptions,
): Promise<void> {
  const captured = capture(captures, facade, options);
  try {
    return await (await facade.start())[method](input, captured.options);
  } finally {
    captured.release();
  }
}
