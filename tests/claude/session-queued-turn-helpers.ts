/** A Claude session stopped with a message still queued, for the C-HOOK-24 session tests (PRD §6.5). */
import { onTestFinished, vi } from "vitest";
import type { ClaudeSessionApi, ElwoodWarningEvent, StartClaudeOptions } from "../../src/index.ts";
import { claudeWorking } from "../fixtures/owned-turn/composer.ts";
import { startPromptActivitySession, user } from "./session-user-activity-helpers.ts";

export const dequeue = { type: "queue-operation", operation: "dequeue" };
export const queuedUser = (promptId: string, text: string) => ({
  ...user(promptId, text),
  promptSource: "queued",
});
/** Past C-HOOK-24's 2-second bound, stated independently of the implementation. */
export const pastBound = () => vi.advanceTimersByTimeAsync(2_100);

export type QueuedStop = {
  readonly onStop?: (session: ClaudeSessionApi) => void;
  readonly options?: Omit<StartClaudeOptions, "cwd">;
  /** The caller's handler is still screening the queued message at the `Stop`. */
  readonly screening?: boolean;
};

export async function stopWithQueuedMessage({ onStop, options, screening }: QueuedStop = {}) {
  // Only the test advances the watcher's background poll; the session starts on real timeouts.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const activity = await startPromptActivitySession(options);
  onTestFinished(() => activity.session.teardown());
  const { session, submit, append } = activity;
  const warnings: ElwoodWarningEvent[] = [];
  session.on("warning", (warning) => void warnings.push(warning));
  await session.sendPrompt("essay");
  await submit("essay", "turn-1");
  append(user("turn-1", "essay"));
  // Claude screens a message queued during the turn under the running turn's prompt ID.
  let noted = false;
  session.on("hook", (event) => {
    noted ||= event.hook_event_name === "UserPromptSubmit" && event.prompt === "note";
  });
  const note = submit("note", "turn-1");
  const seen = () => {
    if (!noted) throw new Error("The note's hook has not arrived.");
  };
  await (screening ? vi.waitFor(seen) : note);
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  // The screen shows the turn working until its `Stop`.
  activity.pty.emitData(claudeWorking);
  await vi.advanceTimersByTimeAsync(20);
  onStop?.(session);
  const stop = (prompt_id: string) =>
    activity.hook({ hook_event_name: "Stop", prompt_id, stop_hook_active: false });
  await stop("turn-1");
  return { ...activity, warnings, stop, note };
}

export const turnEnds = (session: ClaudeSessionApi) =>
  session
    .statusDecisions()
    .filter((decision) => decision.evidence.endsWith("_ended") && decision.to === "ready")
    .map((decision) => decision.evidence);
