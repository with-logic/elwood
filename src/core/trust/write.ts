/**
 * Revalidates trust decisions immediately before numbered/cursor input.
 * Implements PRD §5.4, C-CLAUDE-14, C-CODEX-15, and C-TRUST-01.
 */
import { delay } from "../delay.ts";
import type { StartupWriteCompletion } from "../startup/write.ts";
import { type SelectableOption, selectableOptions } from "../terminal-options.ts";
import { parseTrustDialog, type TrustDialog } from "./dialog.ts";
import { activeTrustDialogVisible, type TrustPromptSpec, trustPromptAllowlist } from "./prompts.ts";
import type { TrustWriteResult } from "./responder.ts";

const trustRetryMs = 250;
const trustAttemptTimeoutMs = 5_000;

type Write = (input: string) => TrustWriteResult;

/** Live attempts retry swallowed input only while the same native choice remains visible. */
export async function writeTrustOption(
  spec: TrustPromptSpec,
  option: SelectableOption,
  write: Write,
  initialDialog: TrustDialog,
  isCurrentGeneration: () => boolean,
  readFrame?: () => string,
): Promise<StartupWriteCompletion> {
  if (option.style === "cursor") {
    if (readFrame === undefined) return "cancelled";
    return navigateCursorOption(spec, write, readFrame);
  }
  if (readFrame === undefined) {
    await write(`${option.number}\r`);
    return "answered";
  }
  const deadline = Date.now() + trustAttemptTimeoutMs;
  let wrote = false;
  while (Date.now() < deadline) {
    const frame = readFrame();
    const parsed = parseTrustDialog(frame);
    const current = activeTrustDialogVisible(parsed, spec) ? parsed : undefined;
    if (current === undefined) {
      return wrote ? afterNumberedWrite(frame, parsed, spec, isCurrentGeneration()) : "cancelled";
    }
    if (
      !isCurrentGeneration() ||
      current.header !== initialDialog.header ||
      !current.options.some(
        (candidate) =>
          candidate.style === "numbered" &&
          candidate.number === option.number &&
          candidate.label === option.label,
      )
    )
      return "cancelled";
    await write(`${option.number}\r`);
    wrote = true;
    await delay(trustRetryMs);
  }
  return "cancelled";
}

function afterNumberedWrite(
  frame: string,
  parsed: TrustDialog | undefined,
  spec: TrustPromptSpec,
  sameGeneration: boolean,
): StartupWriteCompletion {
  // A verified successor gate confirms the original one cleared; never write into it.
  if (
    trustPromptAllowlist.some(
      (next) =>
        next.agent === spec.agent && next.id !== spec.id && activeTrustDialogVisible(parsed, next),
    )
  )
    return "answered";
  // A choice block or trust-like candidate is a replacement, not proof of clearance.
  return sameGeneration && parsed === undefined && !replacementChoices(frame)
    ? "answered"
    : "cancelled";
}

function replacementChoices(frame: string): boolean {
  const options = selectableOptions(frame);
  // A single cursor row is also the native command composer/placeholder.
  return options.length > 1 || options.some((option) => option.style === "numbered");
}

async function navigateCursorOption(
  spec: TrustPromptSpec,
  write: Write,
  readFrame: () => string,
): Promise<StartupWriteCompletion> {
  const deadline = Date.now() + trustAttemptTimeoutMs;
  while (Date.now() < deadline) {
    const dialog = currentDialog(readFrame(), spec);
    if (dialog === undefined) return "cancelled";
    const target = dialog.options.find((option) => spec.accept.test(option.label));
    if (target?.style !== "cursor") {
      await delay(trustRetryMs);
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
  const deadline = Date.now() + trustRetryMs;
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
