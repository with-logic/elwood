/**
 * Codex 0.164.0 closes its picker and reasoning screens with terse hint rows
 * (`enter select · esc back`), and both must still read as Elwood's own live dialog: every
 * key the picker is sent is gated on recognition (PRD §5.7, C-API-23, C-API-24).
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

/** Each CLI owns its closing hint: Claude's `Esc to cancel` does not close a Codex dialog. */
test("C-API-24 a Codex picker closed by Claude's hint is not a live picker", () => {
  const text = viewport("picker").replace("  enter select · esc back", "  Esc to cancel");
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
  // 0.164.0 marks only `(current)`; the default comes from config.toml through the spec's
  // `withDefaults`, which the session's listing runs after this read (PRD §5.3).
  expect(options[0]).toMatchObject({ isCurrent: true, isDefault: false });
  expect(options.filter((option) => option.isDefault)).toEqual([]);
});
