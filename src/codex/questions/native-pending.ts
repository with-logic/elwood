/** Read live queue submission evidence without retaining answer text (PRD §4). */
import type { QuestionFrame } from "../../core/questions/adapter.ts";
import { codexWorkingScreen } from "../screen/working.ts";
import { questionHeader, queuedPanelHeader } from "./chrome.ts";

const pendingHeader = "• Messages to be submitted after next tool call";
const pendingPromptPrefix = "  ↳ > ";

/** Read pending titles only after the latest working row, stopping at queue/composer chrome. */
export function nativePendingPrompts(frame: QuestionFrame): readonly string[] {
  const working = frame.lines.findLastIndex((line) => codexWorkingScreen.test(line));
  if (working < 0) return [];
  const header = frame.lines.findLastIndex((line) => line.startsWith(pendingHeader));
  if (header < working) return [];
  const after = frame.lines.slice(header + 1);
  const end = after.findIndex((line) => line === queuedPanelHeader || line.startsWith("› "));
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
  let quoted = history >= 0;
  for (const line of frame.lines.slice(history + 1)) {
    if (quoted && /^ {2,}\S/.test(line)) continue;
    quoted = false;
    if (line.trim() === queuedPanelHeader || questionHeader.test(line)) return true;
  }
  return false;
}
