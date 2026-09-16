/**
 * Revalidates trust decisions immediately before numbered/cursor input.
 * Implements PRD §5.4, C-CLAUDE-14, C-CODEX-15, and C-TRUST-01.
 */
import { delay } from "../delay.ts";
import { optionInput, type SelectableOption } from "../terminal-options.ts";
import { trustDialog } from "./dialog.ts";
import type { TrustPromptSpec } from "./prompts.ts";
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
): Promise<void> {
  if (option.style === "cursor") {
    if (readFrame === undefined)
      throw new Error("Cursor trust navigation requires live screen reads.");
    return navigateCursorOption(spec, optionInput(option), write, readFrame);
  }
  const current = trustDialog(
    readFrame === undefined ? initialFrame : readFrame(),
    spec.headerPattern,
  );
  if (
    !current?.options.some(
      (candidate) =>
        candidate.style === "numbered" &&
        candidate.number === option.number &&
        spec.accept.test(candidate.label),
    )
  ) {
    throw new Error("Trust prompt disappeared before confirmation.");
  }
  await write(`${option.number}\r`);
}

async function navigateCursorOption(
  spec: TrustPromptSpec,
  originalInput: string,
  write: Write,
  readFrame: () => string,
): Promise<void> {
  const deadline = Date.now() + cursorNavigationTimeoutMs;
  while (Date.now() < deadline) {
    const dialog = trustDialog(readFrame(), spec.headerPattern);
    if (dialog === undefined)
      throw new Error("Cursor trust prompt disappeared before confirmation.");
    const target = dialog.options.find((option) => spec.accept.test(option.label));
    if (target?.style !== "cursor") {
      await delay(cursorRetryMs);
      continue;
    }
    const key = target.offset === 0 ? "\r" : target.offset < 0 ? "\u001b[A" : "\u001b[B";
    await write(key);
    const progress = await waitForCursorProgress(spec, target.offset, readFrame);
    if (progress === "cleared") return;
  }
  throw new Error(`Cursor trust navigation timed out (${originalInput}).`);
}

async function waitForCursorProgress(
  spec: TrustPromptSpec,
  priorOffset: number,
  readFrame: () => string,
): Promise<"cleared" | "retry"> {
  const deadline = Date.now() + cursorRetryMs;
  while (Date.now() < deadline) {
    await delay(20);
    const dialog = trustDialog(readFrame(), spec.headerPattern);
    if (dialog === undefined) {
      if (priorOffset === 0) return "cleared";
      throw new Error("Cursor trust prompt disappeared before confirmation.");
    }
    const target = dialog.options.find((option) => spec.accept.test(option.label));
    if (target?.style === "cursor" && target.offset !== priorOffset) return "retry";
  }
  return "retry";
}
