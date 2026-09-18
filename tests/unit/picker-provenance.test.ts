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
