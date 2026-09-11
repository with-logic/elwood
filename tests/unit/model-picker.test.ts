/**
 * Flow tests for shared model picker automation with a scripted terminal.
 * Covers PRD §5.3, C-API-23, and C-API-24.
 */

import { describe, expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { listPickerModels, pickerTimeout, setPickerModel } from "../../src/core/models/picker.ts";
import {
  claudePicker,
  claudePickerCursorOnHaiku,
  codexPickerCurrentIsDefault,
  codexReasoningScreen,
} from "../helpers/model-pickers.ts";
import { scripted } from "./scripted-terminal.ts";

const submitOk = () => Promise.resolve();

describe("model picker automation", () => {
  test("C-API-23 listPickerModels parses rows and cancels with Escape", async () => {
    const terminal = scripted(claudePicker);
    terminal.onInput = (input) => {
      if (input === "\u001b") terminal.text = "❯ ";
    };
    const options = await listPickerModels(
      { terminal, submit: submitOk },
      claudeModelPicker,
      2_000,
    );
    expect(options.map((option) => option.id)).toContain("haiku");
    expect(terminal.inputs).toEqual(["\u001b"]);
  });

  test("C-API-24 setPickerModel arrows down and applies session-only", async () => {
    const terminal = scripted(claudePicker);
    let downs = 0;
    terminal.onInput = (input) => {
      if (input === "\u001b[B") {
        downs += 1;
        if (downs === 2) terminal.text = claudePickerCursorOnHaiku;
      }
      if (input === "s") terminal.text = "❯ ";
    };
    await setPickerModel({ terminal, submit: submitOk }, claudeModelPicker, "Haiku", 2_000);
    expect(terminal.inputs).toEqual(["\u001b[B", "\u001b[B", "s"]);
  });

  test("C-API-24 setPickerModel arrows up when the target is above the cursor", async () => {
    const terminal = scripted(claudePickerCursorOnHaiku);
    terminal.onInput = (input) => {
      if (input === "\u001b[A") terminal.text = claudePicker;
      if (input === "s") terminal.text = "❯ ";
    };
    await setPickerModel({ terminal, submit: submitOk }, claudeModelPicker, "fable", 2_000);
    expect(terminal.inputs.filter((input) => input === "\u001b[A").length).toBe(2);
  });

  test("C-API-24 unknown ids reject with the available ids and close the picker", async () => {
    const terminal = scripted(claudePicker);
    await expect(
      setPickerModel({ terminal, submit: submitOk }, claudeModelPicker, "gpt-9", 2_000),
    ).rejects.toMatchObject({
      code: "model_automation_failed",
      details: { available: ["default", "opus", "fable", "sonnet", "haiku"] },
    });
    expect(terminal.inputs).toEqual(["\u001b"]);
  });

  test("C-API-23 unparseable screens reject after closing the picker", async () => {
    const terminal = scripted("  Select model\n  no rows rendered here");
    await expect(
      listPickerModels({ terminal, submit: submitOk }, claudeModelPicker, 2_000),
    ).rejects.toMatchObject({ code: "model_automation_failed" });
    expect(terminal.inputs).toEqual(["\u001b"]);
  });

  test("C-API-24 codex apply confirms the model and its default reasoning level", async () => {
    const terminal = scripted(codexPickerCurrentIsDefault);
    let enters = 0;
    terminal.onInput = (input) => {
      if (input !== "\r") return;
      enters += 1;
      terminal.text = enters === 1 ? codexReasoningScreen : "• Model changed to gpt-5.4 medium\n› ";
    };
    await codexModelPicker.apply({ terminal, submit: submitOk }, 2_000);
    expect(terminal.inputs).toEqual(["\r", "\r"]);
  });

  test("C-API-24 setPickerModel bails with a cursor diagnostic when no row is highlighted", async () => {
    // The rows parse but no cursor marker rendered (a partial repaint): the failure names
    // the missing cursor rather than blaming the (valid) model id, and Escape closes the picker.
    const terminal = scripted(claudePicker.replace("❯", " "));
    await expect(
      setPickerModel({ terminal, submit: submitOk }, claudeModelPicker, "haiku", 2_000),
    ).rejects.toMatchObject({
      code: "model_automation_failed",
      message: "Could not locate the picker cursor.",
    });
    expect(terminal.inputs).toEqual(["\u001b"]);
  });

  test("C-API-23 pickerTimeout falls back to the 20s default", () => {
    expect(pickerTimeout()).toBe(20_000);
    expect(pickerTimeout({ timeoutMs: 5 })).toBe(5);
  });
});
