/** Read live queue submission evidence without retaining answer text (PRD §4, §5.10). */
import type { QuestionFrame } from "../../core/questions/adapter.ts";
import { codexWorkingScreen } from "../screen/working.ts";
import { composerInputPrefix, questionHeader, queuedPanelHeader } from "./chrome.ts";

const pendingHeader = "• Messages to be submitted after next tool call";
// The whole header, which a pane narrower than it wraps onto indented rows.
const pendingHeaderText = `${pendingHeader} (press esc to interrupt and send immediately)`;
const pendingPromptPrefix = "  ↳ > ";
// A pending message's first row starts with `↳`; its later rows are indented four spaces.
const pendingMessageRow = /^(?: {2}↳ | {4})/;

/** Read pending titles only after the latest working row, stopping at queue/composer chrome. */
export function nativePendingPrompts(frame: QuestionFrame): readonly string[] {
  const working = frame.lines.findLastIndex((line) => codexWorkingScreen.test(line));
  if (working < 0) return [];
  const header = frame.lines.findLastIndex((line) => line.startsWith(pendingHeader));
  if (header < working) return [];
  const after = frame.lines.slice(header + 1);
  const end = after.findIndex(
    (line) => line === queuedPanelHeader || composerInputPrefix.test(line),
  );
  return (end < 0 ? after : after.slice(0, end))
    .filter((line) => line.startsWith(pendingPromptPrefix))
    .map((line) => line.slice(pendingPromptPrefix.length).trimEnd());
}

/** Ignore contiguous indented assistant quotations; a blank or unindented row ends that history. */
export function nativeQuestionFragment(frame: QuestionFrame): boolean {
  const history = frame.lines.findLastIndex(
    (line) =>
      line.startsWith("• ") &&
      line !== queuedPanelHeader &&
      !line.startsWith(pendingHeader) &&
      !codexWorkingScreen.test(line),
  );
  // Match the composer's bounded assistant-quotation convention: only contiguous
  // indented body rows are history; a blank row restores native-panel detection.
  // Unlike the composer, a `? ` question cell does not start that history: rows under it that
  // read as panel chrome keep input held, the safe answer here.
  let quoted = history >= 0;
  for (const line of frame.lines.slice(history + 1)) {
    if (quoted && /^ {2,}\S/.test(line)) continue;
    quoted = false;
    if (line.trim() === queuedPanelHeader || questionHeader.test(line)) return true;
  }
  return false;
}

/**
 * Whether the rows between the working row and a queued panel are blank or Codex's block of
 * messages it has not submitted yet. Codex 0.172 draws that block right after a queued answer,
 * until it submits the answer, with the hidden cursor still parked on the working row above.
 */
export function blankOrPendingMessages(rows: readonly string[]): boolean {
  const content = rows.filter((row) => row.trim() !== "");
  if (content.length === 0) return true;
  const firstPendingMessageRowIndex = content.findIndex((row) => row.startsWith("  ↳ "));
  if (firstPendingMessageRowIndex < 1) return false;
  const header = content.slice(0, firstPendingMessageRowIndex).map((row) => row.trim());
  return (
    header.join(" ") === pendingHeaderText &&
    content.slice(firstPendingMessageRowIndex).every((row) => pendingMessageRow.test(row))
  );
}
