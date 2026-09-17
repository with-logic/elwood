/**
 * Revalidates trust decisions immediately before numbered/cursor input.
 * Implements PRD §5.4, C-CLAUDE-14, C-CODEX-15, and C-TRUST-01.
 */
import { delay } from "../delay.ts";
import type { StartupWriteCompletion } from "../startup/write.ts";
import type { SelectableOption } from "../terminal-options.ts";
import { parseTrustDialog, type TrustDialog } from "./dialog.ts";
import { activeTrustDialogVisible, type TrustPromptSpec } from "./prompts.ts";
import type { TrustWriteResult } from "./responder.ts";

const cursorRetryMs = 250;
const cursorNavigationTimeoutMs = 5_000;

type Write = (input: string) => TrustWriteResult;

/** A numbered answer is atomic; cursor navigation observes every intermediate frame. */
export async function writeTrustOption(
  spec: TrustPromptSpec,
  option: SelectableOption,
  write: Write,
  initialFrame: string,
  readFrame?: () => string,
): Promise<StartupWriteCompletion> {
  if (option.style === "cursor") {
    if (readFrame === undefined) return "cancelled";
    return navigateCursorOption(spec, write, readFrame);
  }
  const current = currentDialog(readFrame === undefined ? initialFrame : readFrame(), spec);
  if (
    !current?.options.some(
      (candidate) =>
        candidate.style === "numbered" &&
        candidate.number === option.number &&
        spec.accept.test(candidate.label),
    )
  ) {
    return "cancelled";
  }
  await write(`${option.number}\r`);
  return "answered";
}

async function navigateCursorOption(
  spec: TrustPromptSpec,
  write: Write,
  readFrame: () => string,
): Promise<StartupWriteCompletion> {
  const deadline = Date.now() + cursorNavigationTimeoutMs;
  while (Date.now() < deadline) {
    const dialog = currentDialog(readFrame(), spec);
    if (dialog === undefined) return "cancelled";
    const target = dialog.options.find((option) => spec.accept.test(option.label));
    if (target?.style !== "cursor") {
      await delay(cursorRetryMs);
      continue;
    }
    const key = target.offset === 0 ? "\r" : target.offset < 0 ? "\u001b[A" : "\u001b[B";
    await write(key);
    const progress = await waitForCursorProgress(spec, target.offset, readFrame);
    if (progress === "cleared") return "answered";
    if (progress === "cancelled") return "cancelled";
  }
  return "cancelled";
}

async function waitForCursorProgress(
  spec: TrustPromptSpec,
  priorOffset: number,
  readFrame: () => string,
): Promise<"cleared" | "retry" | "cancelled"> {
  const deadline = Date.now() + cursorRetryMs;
  while (Date.now() < deadline) {
    await delay(20);
    const dialog = currentDialog(readFrame(), spec);
    if (dialog === undefined) {
      if (priorOffset === 0) return "cleared";
      return "cancelled";
    }
    const target = dialog.options.find((option) => spec.accept.test(option.label));
    if (target?.style === "cursor" && target.offset !== priorOffset) return "retry";
  }
  return "retry";
}

function currentDialog(frame: string, spec: TrustPromptSpec): TrustDialog | undefined {
  const dialog = parseTrustDialog(frame);
  return activeTrustDialogVisible(dialog, spec) ? dialog : undefined;
}
