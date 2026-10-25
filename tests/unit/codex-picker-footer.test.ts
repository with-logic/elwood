/**
 * Codex 0.164.0 closes its picker and reasoning screens with terse hint rows
 * (`enter select · esc back`), and both must still read as Elwood's own live dialog: the
 * picker is parsed only once recognized, and every key it is sent is gated on recognition
 * (PRD §5.7, C-API-23, C-API-24).
 */
import { expect, test } from "vitest";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { listPickerModels } from "../../src/core/models/picker.ts";
import type { ModelDialogAuthority } from "../../src/core/models/rows.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { scripted } from "./scripted-terminal.ts";

/** A full real Codex 0.164.0 viewport (2026-10-25, project path trimmed). */
const viewport = (name: string) => capturedFrame(`codex-0.164.0/model-picker/${name}`);

const opened: ModelDialogAuthority = { opened: true };

test("C-API-24 the captured 0.164.0 picker is a live picker", () => {
  expect(codexModelPicker.activeDialog(viewport("picker"), opened)).toBe("picker");
});

test("C-API-24 the captured 0.164.0 reasoning screen is a live follow-up", () => {
  expect(codexModelPicker.activeDialog(viewport("reasoning"), opened)).toBe("follow-up");
});

test("C-API-24 the terse hint inside a sentence does not close a dialog", () => {
  const prose = viewport("picker").replace(
    "  enter select · esc back",
    "  Then press enter select · esc back. to leave the list",
  );
  expect(codexModelPicker.activeDialog(prose, opened)).toBeUndefined();
});

/** Scroll markers and the overflow line are Claude's; on a Codex list they are foreign. */
test.each([
  ["a `↓` row", "  7. GPT-5.6-Luna ", "↓ 7. GPT-5.6-Luna "],
  [
    "an overflow line",
    "  7. GPT-5.6-Luna           Older fast and efficient model.",
    "  7. GPT-5.6-Luna           Older fast and efficient model.\n     … +2 models",
  ],
])("C-API-24 a Codex picker with %s is not a live picker", (_name, from, to) => {
  const text = viewport("picker").replace(from, to);
  expect(text).not.toBe(viewport("picker"));
  expect(codexModelPicker.activeDialog(text, opened)).toBeUndefined();
});

test("C-API-23 listPickerModels reads every row of the 0.164.0 picker", async () => {
  const terminal = scripted(viewport("picker"));
  terminal.onInput = (input) => {
    if (input === "\u001b") terminal.text = "› ";
  };
  const options = await listPickerModels(
    { terminal, submit: () => Promise.resolve() },
    codexModelPicker,
    2_000,
  );
  expect(options.map((option) => option.id)).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  expect(options[0]).toMatchObject({ isCurrent: true, isDefault: true });
});
