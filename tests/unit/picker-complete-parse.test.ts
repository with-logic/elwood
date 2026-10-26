/**
 * The picker is parsed only once its whole native dialog has painted: a frame that merely
 * shows the header can hold a few rows above Claude's stale slash-command menu, and a list
 * parsed from it is a partial catalog (PRD §5.3, C-API-23, C-API-24).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { listPickerModels, setPickerModel } from "../../src/core/models/picker.ts";
import { capturedFrame, capturedWalk } from "../helpers/captured-frames.ts";
import { scripted } from "./scripted-terminal.ts";

/** A real Claude 2.1.310 frame (2026-10-24): header to viewport bottom, 13 models. */
const frame = (name: string) => capturedFrame(`claude-2.1.310/model-picker/${name}`);

/** Submitting `/model` paints the named real partial frames in order, then `complete`. */
function painting(partials: readonly [string, ...string[]], complete: string) {
  const terminal = scripted("❯ ");
  const submit = () => {
    terminal.text = frame(partials[0]);
    partials.slice(1).forEach((partial, index) => {
      setTimeout(() => (terminal.text = frame(partial)), 150 * (index + 1));
    });
    setTimeout(() => (terminal.text = complete), 150 * partials.length);
    return Promise.resolve();
  };
  return { terminal, submit };
}

/** The real walk from `top-window`, which opens it, down to the last of its 13 rows. */
const walk = capturedWalk("claude-2.1.310/model-picker/walk-down-from-top");
const catalog = claudeModelPicker
  .parse(frame("top-window"))
  .options.map((option) => option.id)
  .concat("opus 4.7", "opus 4.6", "sonnet 4.6");

test.each([
  ["three rows above the slash-command menu", ["painting-three-rows"]],
  ["seven rows above the slash-command menu", ["painting-seven-rows"]],
  ["each partial frame in turn", ["painting-three-rows", "painting-seven-rows"]],
] as const)("C-API-23 listPickerModels waits out a picker painting %s", async (_name, names) => {
  const { terminal, submit } = painting(names, frame("top-window"));
  let step = 0;
  terminal.onInput = (input) => {
    if (input === "\u001b") terminal.text = "❯ ";
    else if (input === walk.steps[step]?.key) terminal.text = walk.steps[step++]?.frame ?? "";
  };
  const options = await listPickerModels({ terminal, submit }, claudeModelPicker, 2_000);
  expect(options.map((option) => option.id)).toEqual(catalog);
  expect(terminal.inputs).toEqual([...new Array<string>(12).fill("\u001b[B"), "\u001b"]);
});

test("C-API-24 setPickerModel finds a row the partial frame had not painted yet", async () => {
  const { terminal, submit } = painting(["painting-three-rows"], frame("top-window"));
  let downs = 0;
  terminal.onInput = (input) => {
    if (input === "\u001b[B") downs += 1;
    if (downs === 8) terminal.text = frame("cursor-on-row-9");
    if (input === "s") terminal.text = "❯ ";
  };
  await setPickerModel({ terminal, submit }, claudeModelPicker, "fable 5", 2_000);
  expect(terminal.inputs).toEqual([...new Array<string>(8).fill("\u001b[B"), "s"]);
});

/**
 * Once the operation's own deadline or the session's close has aborted it, nothing may be
 * written: the failure is handed to cleanup instead of Escaping from here.
 */
test("C-API-55 an aborted operation writes nothing while the rows are still painting", async () => {
  const { terminal, submit } = painting(["painting-three-rows"], frame("top-window"));
  const operation = new AbortController();
  const reason = new Error("operation deadline");
  setTimeout(() => operation.abort(reason), 50);
  await expect(
    listPickerModels(
      { terminal, submit: () => submit(), signal: operation.signal },
      claudeModelPicker,
      10_000,
    ),
  ).rejects.toBe(reason);
  expect(terminal.inputs).toEqual([]);
});
