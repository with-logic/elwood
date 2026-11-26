/**
 * A failed model operation closes its own picker by ownership, even when no grammar parses
 * the layout, so a parse failure never leaves the picker open and input held. Only the
 * picker's own window gets that Escape: a follow-up stage or a human's prompt under a stale
 * title is never mistaken for it (PRD §5.3, C-API-55).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { ElwoodError, elwoodError } from "../../src/core/errors.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import {
  claudeClosedPickerViewport,
  codexClosedPickerViewport,
  codexPickerViewport,
  codexReasoningViewport,
} from "../helpers/model-dialog-viewports.ts";
import {
  escapeKey,
  failure,
  guardedPickerHarness,
  type Screen,
} from "../helpers/picker-harness.ts";
import { partialReasoning } from "./picker-close-wait-harness.ts";

// Claude 2.1.332 at 100x10: the picker's hint row falls below the pane.
const footerCut = capturedFrame("claude-2.1.332/model-picker/footer-cut");
const escapes = (writes: readonly string[]) => writes.filter((write) => write === escapeKey);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Our Claude picker in its footer-cut layout; `onEscape` scripts the CLI's repaint. */
function claudeHarness(onEscape: (screen: Screen) => void) {
  return guardedPickerHarness(claudeClosedPickerViewport, (input, screen) => {
    if (input === escapeKey) onEscape(screen);
  });
}

test("C-API-55 the footer-cut picker shows its own window, which no grammar parses", () => {
  expect(claudeModelPicker.activeDialog(footerCut, { opened: true })).toBeUndefined();
  expect(claudeModelPicker.isOwnPickerWindow(footerCut, { opened: true })).toBe(true);
  // Without the transaction's authority, nothing on screen is our picker.
  expect(claudeModelPicker.isOwnPickerWindow(footerCut, { opened: false })).toBe(false);
  // A row numbered past the window's opening position is not the picker's own window.
  const misplaced = footerCut.replace("❯ 1.  Default", "❯ 4.  Default");
  expect(misplaced).not.toBe(footerCut);
  expect(claudeModelPicker.isOwnPickerWindow(misplaced, { opened: true })).toBe(false);
});

test("C-API-55 cleanup closes its own unparsed picker, then queued input is delivered", async () => {
  // The CLI takes 200 ms to repaint the composer after Escape.
  const { writes, queue, picker, failWith, delivered } = claudeHarness((screen) => {
    setTimeout(() => {
      screen.text = claudeClosedPickerViewport;
    }, 200);
  });
  const failed = expect(failWith(footerCut)).rejects.toBe(failure);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
  expect(writes.slice(0, 2)).toEqual(["/model", escapeKey]);
  expect(escapes(writes)).toHaveLength(1);
  expect(delivered("hello")).toBe(1);
  expect(picker.blocksInput()).toBe(false);
  await message;
  queue.close();
});

test("C-API-55 an unparsed picker that ignores its Escape gets no second one and holds input", async () => {
  const { writes, queue, picker, failWith, delivered } = claudeHarness(() => {});
  const failed = expect(failWith(footerCut)).rejects.toBe(failure);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(5000);
  await failed;
  expect(writes).toEqual(["/model", escapeKey]);
  expect(delivered("hello")).toBe(0);
  expect(picker.blocksInput()).toBe(true);
  queue.close();
  await message.catch(() => undefined);
});

test("C-API-55 the rejection names the unparsed layout and keeps its code", async () => {
  const timedOut = elwoodError("model_automation_failed", "Timed out waiting for the picker.");
  const { failWith } = claudeHarness((screen) => {
    screen.text = claudeClosedPickerViewport;
  });
  const failed = failWith(footerCut, timedOut).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2000);
  const error = await failed;
  expect(error).toBeInstanceOf(ElwoodError);
  expect(error).toMatchObject({ code: "model_automation_failed" });
  expect((error as Error).message).toMatch(
    /^Timed out waiting for the picker\. The claude model picker was open in a layout Elwood could not parse/,
  );
  // The original's stack still says where the failure arose.
  expect((error as Error).stack).toBe(timedOut.stack);
});

test("C-API-55 any other typed error from an unparsed picker passes through unchanged", async () => {
  const other = elwoodError("wait_timeout", "Raw input replaced the staged turn input.");
  const { failWith } = claudeHarness((screen) => {
    screen.text = claudeClosedPickerViewport;
  });
  const failed = expect(failWith(footerCut, other)).rejects.toBe(other);
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
});

const capture: unknown = JSON.parse(
  readFileSync(
    new URL("../fixtures/claude-2.1.310/permission-declined/dialog.json", import.meta.url),
    "utf8",
  ),
);
if (typeof capture !== "object" || capture === null || !("text" in capture))
  throw new Error("permission-declined/dialog.json has no `text`");
const { text: permission } = capture;
if (typeof permission !== "string") throw new Error("permission-declined/dialog.json `text`");
const unvouched = (fixture: string, marker: RegExp) => {
  const text = capturedFrame(fixture).replace(marker, "");
  return text.replace(/\n[^\n]*(?:Esc to cancel|esc back)[^\n]*\n*$/u, "\n");
};

test.each([
  ["a partial trust prompt", "   Select model\n\nDo you trust the files in this folder?"],
  [
    "a partial hook confirmation",
    "   Select model\n\nSwitch model?\nA PreModelSwitch hook asked you to confirm",
  ],
  [
    "a permission prompt quoting the title, its footer cut",
    permission
      .replace("Create elwood.txt containing hello", "Find the Select model header in src")
      .replace(" Esc to cancel · Tab to amend", ""),
  ],
  [
    "a lone row with no marker to vouch for it, its footer cut",
    unvouched("claude-2.1.332/model-picker/one-row", /\n {4}↓ 5 more/u),
  ],
] as const)("C-API-55 %s gets no Escape", async (_description, prompt) => {
  expect(claudeModelPicker.isCandidate(prompt)).toBe(true);
  const { writes, failWith } = claudeHarness(() => {});
  const failed = expect(failWith(prompt)).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
  expect(writes).toEqual(["/model"]);
});

test("C-API-55 a Codex row between bare arrows, its footer cut, is unvouched and gets no Escape", async () => {
  const oneRow = unvouched("codex-0.169.0/model-picker/middle", /(?<=↑\n)(?: {2}\d\..*\n)+/u);
  expect(oneRow).toMatch(/↑\n› 9\..*\n↓\n$/u);
  expect(codexModelPicker.isCandidate(oneRow)).toBe(true);
  const { writes, failWith } = guardedPickerHarness(
    codexClosedPickerViewport,
    () => {},
    codexModelPicker,
  );
  const failed = expect(failWith(oneRow)).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
  expect(writes).toEqual(["/model"]);
});

test("C-API-55 a half-painted Codex follow-up is not the picker, so each stage gets its Escape", async () => {
  // Escape on the reasoning level returns to the picker; Escape there closes it.
  const { screen, writes, queue, picker, failWith, delivered } = guardedPickerHarness(
    codexClosedPickerViewport,
    (input, current) => {
      if (input !== escapeKey) return;
      current.text =
        current.text === codexPickerViewport ? codexClosedPickerViewport : codexPickerViewport;
    },
    codexModelPicker,
  );
  const failed = expect(failWith(partialReasoning)).rejects.toBe(failure);
  // The follow-up finishes painting after cleanup's first reading.
  setTimeout(() => {
    if (screen.text === partialReasoning) screen.text = codexReasoningViewport;
  }, 150);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
  expect(escapes(writes)).toHaveLength(2);
  expect(delivered("hello")).toBe(1);
  expect(picker.blocksInput()).toBe(false);
  await message;
  queue.close();
});
