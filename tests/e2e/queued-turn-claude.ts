/**
 * Shared real-Claude setup for the queued-turn readiness e2e tests (PRD §6.5, C-HOOK-24): a
 * session writing a long tool-free essay, so guidance sent now queues behind a running turn.
 */
import {
  type ClaudeHookEventFor,
  type ClaudeHookResultForEvent,
  type ClaudeSessionApi,
  startClaude,
} from "../../src/index.ts";
import { cleanup, makeProject, waitFor, waitForVisibleTurn } from "./helpers.ts";

export const queuedTurnMarker = "ELWOOD_QUEUED_TURN";

type ScreenResult = ClaudeHookResultForEvent<ClaudeHookEventFor<"UserPromptSubmit">> | undefined;
type Screen = (
  event: ClaudeHookEventFor<"UserPromptSubmit">,
) => ScreenResult | Promise<ScreenResult>;

export type QueuedTurnObservations = {
  stops: number;
  transcript: string;
  replied: boolean;
  readonly warnings: string[];
  /** The `Stop` count each time the session became `ready`. */
  readonly readyAfterStops: number[];
  /** The `Stop` count when each guidance `UserPromptSubmit` arrived. */
  readonly guidanceAfterStops: number[];
  /** Resolves at the essay's `Stop`. */
  readonly firstStop: Promise<void>;
};

/** Starts the essay. `screen` is the caller's `UserPromptSubmit` handler for guidance. */
export async function startEssay(
  screen?: Screen,
): Promise<{ session: ClaudeSessionApi; seen: QueuedTurnObservations }> {
  const project = makeProject("claude");
  const guidance = (prompt: string) => prompt.includes("Coordinator");
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
    hooks: {
      UserPromptSubmit: (event) => (screen && guidance(event.prompt) ? screen(event) : undefined),
    },
  });
  let stopped = () => {};
  const firstStop = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const seen: QueuedTurnObservations = {
    stops: 0,
    transcript: "",
    replied: false,
    warnings: [],
    readyAfterStops: [],
    guidanceAfterStops: [],
    firstStop,
  };
  try {
    session.on("hook", (event) => {
      if (event.hook_event_name === "UserPromptSubmit" && guidance(event.prompt))
        seen.guidanceAfterStops.push(seen.stops);
      if (event.hook_event_name !== "Stop") return;
      seen.stops += 1;
      seen.transcript = event.transcript_path ?? seen.transcript;
      stopped();
    });
    session.on("activity", (event) => {
      if (event.kind === "assistant_message" && event.text?.includes(queuedTurnMarker))
        seen.replied = true;
    });
    session.on("warning", (warning) => void seen.warnings.push(warning.code));
    await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
    session.on("status", (event) => {
      if (event.status === "ready") seen.readyAfterStops.push(seen.stops);
    });
    await session.sendMessage(
      "Write a detailed 400-word essay about the history of terminals. Do not use tools.",
    );
    await waitForVisibleTurn(session);
    return { session, seen };
  } catch (error) {
    await cleanup(session);
    throw error;
  }
}

/** The evidence of each transition to `ready` since the essay was sent. */
export function readyEvidenceSinceEssay(session: ClaudeSessionApi): readonly string[] {
  const decisions = session.statusDecisions();
  const essay = decisions.findLastIndex((decision) => decision.evidence === "caller_submitted");
  return decisions
    .slice(essay)
    .filter((decision) => decision.to === "ready")
    .map((decision) => decision.evidence);
}
