/**
 * Wires the bounded Codex transcript watcher to the session's warning sink.
 * The watcher is constructed BEFORE the session object, so a drop/read-error
 * notice observed early must be BUFFERED and flushed through `recordWarnings`
 * once the sink exists — never dropped or emitted activity-only (which would
 * neither persist nor replay). Mirrors Claude's wiring. Implements PRD §5.4.
 */

import * as activity from "../core/activity.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { CodexEventMap } from "./session-types.ts";
import { CodexTranscriptWatcher, codexDropWarning, codexReadErrorWarning } from "./transcript.ts";

/** The session-side sink that persists, de-duplicates, and replays warnings. */
export type CodexWarningSink = {
  readonly recordWarnings: (warnings: readonly ElwoodWarningEvent[]) => void;
};

/**
 * Builds the transcript watcher, routing its content-free drop/read-error notices
 * to the session's warning sink. Notices seen before `getSink()` resolves are held
 * in `pending` and flushed the first time the sink is available (PRD §5.4/§5.7).
 */
export function createCodexTranscriptWatcher(
  elwoodSessionId: string,
  emitter: TypedEmitter<CodexEventMap>,
  getSink: () => CodexWarningSink | undefined,
): CodexTranscriptWatcher {
  const pending: ElwoodWarningEvent[] = [];
  const route = (warning: ElwoodWarningEvent) => {
    const sink = getSink();
    if (!sink) {
      pending.push(warning); // sink not ready yet: hold until it is, don't drop
      return;
    }
    if (pending.length > 0) sink.recordWarnings(pending.splice(0));
    sink.recordWarnings([warning]);
  };
  return new CodexTranscriptWatcher(
    elwoodSessionId,
    (event) => {
      emitter.emit("codex:transcript", event);
      emitter.emit("activity", activity.activityFromCodexTranscript(event));
    },
    {
      onDrop: (notice) => route(codexDropWarning(notice)),
      onReadError: (notice) => route(codexReadErrorWarning(notice)),
    },
  );
}
