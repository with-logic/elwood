/**
 * The evidence C-E2E-26 and C-E2E-27 share: what reached Codex that should not have, and
 * how the skip went: one `Skip` digit, reported once and never as a dialog nobody
 * recognized, with Codex's update state untouched (PRD §5.5, §12, C-CODEX-27).
 */

import type { CodexSessionApi, ElwoodActivityEvent } from "../../../src/index.ts";
import { readCodexDismissedVersion } from "../codex-update-check.ts";
import type { CodexUpdateOffer } from "./index.ts";
import { refusedWithMarkedRows } from "./screen.ts";

type ActivityLabel = Pick<ElwoodActivityEvent, "kind" | "label">;

/** The activity `session` reports from now on. */
export function recordActivity(session: CodexSessionApi): readonly ActivityLabel[] {
  const activity: ActivityLabel[] = [];
  session.on("activity", (event) => {
    activity.push({ kind: event.kind, label: event.label });
  });
  return activity;
}

/**
 * Writes the guard refused, with the marked rows of the screens they met, and errors from
 * admitted writes. Only Elwood's Skip may reach the offer, and no input may come before it
 * or before Codex's configured composer.
 */
export function inputProblems(input: CodexUpdateOffer) {
  return { refused: refusedWithMarkedRows(input.refused), writeErrors: [...input.writeErrors] };
}

export const noInputProblems = { refused: [], writeErrors: [] };

/** How the skip went, once the queued prompt is answered. */
export function skipEvidence(
  input: CodexUpdateOffer,
  activity: readonly ActivityLabel[],
  home: string,
) {
  const count = (matches: (event: ActivityLabel) => boolean) => activity.filter(matches).length;
  return {
    skipDigits: input.skips.length,
    // Codex's repaint after the skip is the skip's, never a dialog nobody recognized.
    unidentifiedDialogs: count((event) => event.label === "codex-unidentified-dialog"),
    skipsReported: count((event) => event.kind === "startup_prompt" && event.label === "update"),
    // `Skip`, unlike `Skip until next version`, leaves Codex's update state alone.
    dismissedVersion: readCodexDismissedVersion(home),
  };
}

export const skippedOnce = {
  skipDigits: 1,
  unidentifiedDialogs: 0,
  skipsReported: 1,
  dismissedVersion: null,
};
