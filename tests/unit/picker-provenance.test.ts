/** Only a bottom-most native model dialog is Elwood's to cancel or hold on (PRD §5.3, C-API-55). */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";
import {
  claudeCacheWarningViewport,
  claudePickerViewport,
  codexPickerViewport,
} from "../helpers/model-dialog-viewports.ts";
import { claudePicker, codexReasoningScreen } from "../helpers/model-pickers.ts";

/** A running turn: the agent's reply quotes a dialog above the live working row and composer. */
const quotedInReply = (bullet: string, quoted: string, caret: string) =>
  [
    `${bullet} The dialog looks like this:`,
    quoted,
    "",
    "  Working (esc to interrupt)",
    "",
    caret,
  ].join("\n");

test.each([
  ["Claude picker", claudeModelPicker, quotedInReply("⏺", claudePicker, "❯ ")],
  [
    "Claude picker (older bullet)",
    claudeModelPicker,
    quotedInReply("●", claudePickerViewport, "❯"),
  ],
  ["Claude cache warning", claudeModelPicker, quotedInReply("⏺", claudeCacheWarningViewport, "❯ ")],
  ["Codex picker", codexModelPicker, quotedInReply("•", codexPickerViewport, "› Ask Codex")],
  ["Codex reasoning level", codexModelPicker, quotedInReply("•", codexReasoningScreen, "› ")],
] as const)("C-API-55 a %s quoted in a running turn's reply is never cancelled or held on", async (_name, spec, forged) => {
  const writes: string[] = [];
  const screen = { text: "  Working (esc to interrupt)\n\n❯ " };
  const terminal = {
    snapshot: () => ({ text: screen.text }),
    sendInput: (input: string | Uint8Array) => void writes.push(String(input)),
  };
  const queue = new ControlQueue(
    () => Promise.resolve(),
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    terminal,
    controlQueue: queue,
    blocked: () => false,
    picker: () => claudeModelPicker,
    submitDirect: () => Promise.resolve(),
  });
  queue.markReady();
  const failure = new Error("timed out");
  // The reply streams the quote in while the operation is failing.
  const failed = picker.run("list_models", spec, 5000, () => {
    screen.text = forged;
    return Promise.reject(failure);
  });
  await expect(failed).rejects.toBe(failure);
  // An Escape here would interrupt the running turn.
  expect(writes).toEqual([]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

/**
 * A model dialog a HUMAN opened is not Elwood's: it never becomes a cleanup `survivor`, so
 * ownership alone would leave it unguarded. Enter on it still applies the highlighted row
 * and Escape still discards the human's state, so a write outside any picker transaction
 * (`/login` recovery) must be withheld while it is up — without suppressing readiness,
 * which would deadlock Elwood's own picker (C-API-55).
 */
test("C-API-55 a human's model picker withholds non-picker writes but not readiness", () => {
  const screen = { text: claudePicker };
  const queue = new ControlQueue(
    () => Promise.resolve(),
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    terminal: { snapshot: () => ({ text: screen.text }), sendInput: () => undefined },
    controlQueue: queue,
    blocked: () => false,
    picker: () => claudeModelPicker,
    submitDirect: () => Promise.resolve(),
  });
  // Nobody here opened it, so it is not a survivor and must not suppress readiness.
  expect(picker.blocksInput()).toBe(false);
  // But a non-picker write must still stand off it.
  expect(picker.foreignDialogVisible()).toBe(true);
  // Once the human closes it, writes resume.
  screen.text = "❯ ";
  expect(picker.foreignDialogVisible()).toBe(false);
  queue.close();
});

/**
 * A dialog our OWN cleanup could not cancel is already held by `blocksInput`, which feeds
 * readiness. `foreignDialogVisible` is only for a dialog nobody here opened, so once a
 * survivor is latched it defers rather than reporting the same dialog twice (C-API-55).
 */
test("C-API-55 a survivor is not also reported as a foreign dialog", async () => {
  // Starts at the composer: the operation itself opens the picker, as in a real flow.
  const screen = { text: "❯ " };
  const queue = new ControlQueue(
    () => Promise.resolve(),
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    // A permanently failed render means cleanup can never vouch for the screen, so its
    // Escape is withheld and the dialog is latched as a survivor.
    terminal: {
      snapshot: () => ({ text: screen.text }),
      sendInput: () => undefined,
      renderFailed: true,
    },
    controlQueue: queue,
    blocked: () => false,
    picker: () => claudeModelPicker,
    submitDirect: () => Promise.resolve(),
  });
  queue.markReady();
  const failure = new Error("navigation failed");
  await expect(
    picker.run("set_model", claudeModelPicker, 5_000, () => {
      screen.text = claudePicker;
      return Promise.reject(failure);
    }),
  ).rejects.toBe(failure);
  expect(picker.blocksInput()).toBe(true);
  expect(picker.foreignDialogVisible()).toBe(false);
  queue.close();
}, 10_000);
