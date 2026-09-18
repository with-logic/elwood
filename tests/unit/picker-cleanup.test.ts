/** A failed model operation cancels its own dialog, or holds input on it (PRD §5.3, C-API-55). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { type ModelPickerSpec, setPickerModel } from "../../src/core/models/picker.ts";
import type { ModelDialogAuthority } from "../../src/core/models/rows.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";
import {
  claudeHookSwitchConfirmation,
  claudeModelCacheConfirmationOnNo,
  claudePicker,
  codexPickerCurrentIsDefault,
  codexReasoningScreen,
} from "../helpers/model-pickers.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const escapeKey = String.fromCharCode(27);
const failure = new Error("navigation failed");
type Screen = { text: string };

/** `react` scripts how the fake CLI repaints after each command or key Elwood writes. */
function setup(
  spec: ModelPickerSpec,
  react: (input: string, screen: Screen) => void = () => {},
  /** Observation-barrier state a real terminal carries (`renderFailed`, `settled`). */
  barrier: { readonly renderFailed?: boolean } = {},
) {
  const screen: Screen = { text: "❯ " };
  const writes: string[] = [];
  const terminal = {
    ...barrier,
    snapshot: () => ({ text: screen.text }),
    sendInput: (input: string | Uint8Array) => {
      writes.push(String(input));
      return react(String(input), screen);
    },
  };
  /** The harness stands in for a transaction Elwood opened. */
  const opened: ModelDialogAuthority = { opened: true };
  const leaked: string[] = [];
  const queue = new ControlQueue(
    (input) => {
      if (spec.activeDialog(screen.text, opened) !== undefined) leaked.push(String(input));
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    terminal,
    controlQueue: queue,
    blocked: () => false,
    picker: () => spec,
    submitDirect: (command) => Promise.resolve(terminal.sendInput(command)),
  });
  queue.markReady();
  /** An operation that fails with `dialog` still on screen. */
  const failWith = (dialog: string) =>
    picker.run("set_model", spec, 5000, () => {
      screen.text = dialog;
      return Promise.reject(failure);
    });
  return { screen, writes, leaked, queue, picker, failWith };
}

test("C-API-55 a failed operation's picker is cancelled before queued input is released", async () => {
  // The CLI takes 200ms to repaint after Escape.
  const { writes, leaked, queue, picker, failWith } = setup(claudeModelPicker, (_input, shown) => {
    setTimeout(() => {
      shown.text = "❯ ";
    }, 200);
  });
  const failed = expect(failWith(claudePicker)).rejects.toBe(failure);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(300);
  await Promise.all([failed, message]);
  expect(writes).toEqual([escapeKey]);
  expect(leaked).toEqual([]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test.each([
  ["Codex reasoning level", codexModelPicker, codexReasoningScreen, codexPickerCurrentIsDefault],
  ["Claude cache warning", claudeModelPicker, claudeModelCacheConfirmationOnNo, claudePicker],
] as const)("C-API-55 cancelling a %s returns to the picker, which is cancelled too", async (_name, spec, followUp, pickerText) => {
  // Real Claude 2.1.274 and Codex 0.154.0: Escape on the follow-up stage reopens the picker.
  const { writes, leaked, queue, picker, failWith } = setup(spec, (_input, shown) => {
    shown.text = shown.text === followUp ? pickerText : "❯ ";
  });
  const failed = expect(failWith(followUp)).rejects.toBe(failure);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(300);
  await Promise.all([failed, message]);
  expect(writes).toEqual([escapeKey, escapeKey]);
  expect(leaked).toEqual([]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test.each([
  ["ignores Escape", () => {}],
  ["rejects the write", () => Promise.reject(new Error("write failed"))],
] as const)("C-API-55 a dialog that survives cleanup holds input until it clears (the CLI %s)", async (_name, react) => {
  const { screen, writes, queue, picker, failWith } = setup(claudeModelPicker, react);
  const failed = expect(failWith(claudePicker)).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(1100);
  await failed;
  expect(writes).toEqual([escapeKey]);
  expect(picker.blocksInput()).toBe(true);
  screen.text = "❯ ";
  expect(picker.blocksInput()).toBe(false);
  // The hold is forgotten: the same text reappearing later belongs to someone else.
  screen.text = claudePicker;
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 an Escape the operation already wrote is not repeated", async () => {
  // The CLI takes 200ms to repaint after Escape; the picker is still on screen at cleanup.
  const { writes, queue, picker } = setup(claudeModelPicker, (input, shown) => {
    if (input === "/model") shown.text = claudePicker;
    if (input === escapeKey)
      setTimeout(() => {
        shown.text = "❯ ";
      }, 200);
  });
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, (io) =>
      setPickerModel(io, claudeModelPicker, "no-such-model", 5000),
    ),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  await vi.advanceTimersByTimeAsync(500);
  await failed;
  expect(writes).toEqual(["/model", escapeKey]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 terminating during cleanup stops it before any further write", async () => {
  const { writes, queue, picker, failWith } = setup(codexModelPicker, (_input, shown) => {
    shown.text = codexPickerCurrentIsDefault;
  });
  const failed = expect(failWith(codexReasoningScreen)).rejects.toThrow("closed");
  await vi.advanceTimersByTimeAsync(50);
  queue.close();
  await vi.advanceTimersByTimeAsync(1100);
  await failed;
  // The reopened picker never receives its Escape, and a closed session holds nothing.
  expect(writes).toEqual([escapeKey]);
  expect(picker.blocksInput()).toBe(false);
});

test("C-API-55 an unrelated dialog is left open on failure", async () => {
  const { writes, queue, picker, failWith } = setup(claudeModelPicker);
  await expect(failWith(claudeHookSwitchConfirmation)).rejects.toBe(failure);
  expect(writes).toEqual([]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

/**
 * Cleanup decides its Escape on everything RECEIVED, not the last rendered frame. When the
 * screen cannot be vouched for — here a failed render — `writeUnsafe` fails closed, so the
 * Escape is withheld rather than aimed at a stale picker that a permission or hook dialog
 * may already have replaced in the PTY buffer. The dialog then survives and holds input,
 * which is the safe outcome (C-API-55, C-API-56).
 */
test("C-API-55 cleanup withholds its Escape while the screen cannot be vouched for", async () => {
  // A render failure is permanent for the terminal: the snapshot is never trustworthy again.
  const { writes, queue, picker, failWith } = setup(claudeModelPicker, undefined, {
    renderFailed: true,
  });
  const failed = expect(failWith(claudePicker)).rejects.toBe(failure);
  // Run out the whole cleanup bound: every poll must reach the same fail-closed answer.
  await vi.advanceTimersByTimeAsync(1_500);
  await failed;
  // The `/model` submission is there; no Escape ever followed it.
  expect(writes.filter((write) => write === escapeKey)).toEqual([]);
  // Nothing could be cancelled, so the dialog is a survivor and keeps holding input.
  expect(picker.blocksInput()).toBe(true);
  queue.close();
});
