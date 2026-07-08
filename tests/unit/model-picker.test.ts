/**
 * Flow tests for shared model picker automation with a scripted terminal.
 * Covers PRD §5.3, C-API-23, and C-API-24.
 */

import { describe, expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { listPickerModels, pickerTimeout, setPickerModel } from "../../src/core/model-picker.ts";
import { parseClaudeModelPicker } from "../../src/core/model-rows.ts";
import { openCommandScreen, waitForScreen } from "../../src/core/tui-screen.ts";
import {
  claudePicker,
  claudePickerCursorOnHaiku,
  codexPickerCurrentIsDefault,
  codexReasoningScreen,
} from "../helpers/model-pickers.ts";

type ScriptedTerminal = {
  text: string;
  readonly inputs: string[];
  sendInput(data: string | Uint8Array): void;
  snapshot(): { readonly text: string };
  onInput?: (data: string) => void;
};

function scripted(initialText: string): ScriptedTerminal {
  const terminal: ScriptedTerminal = {
    text: initialText,
    inputs: [],
    snapshot: () => ({ text: terminal.text }),
    sendInput: (data) => {
      const input = String(data);
      terminal.inputs.push(input);
      terminal.onInput?.(input);
    },
  };
  return terminal;
}

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

  test("C-API-35 openCommandScreen re-submits the command when the picker is dropped", async () => {
    // The first submit is lost (composer redraw during MCP boot); the picker
    // only appears after a re-submit on the nudge interval.
    const terminal = scripted("still the composer");
    let submits = 0;
    const submit = () => {
      submits += 1;
      if (submits >= 2) terminal.text = claudePicker;
      return Promise.resolve();
    };
    const text = await openCommandScreen({
      terminal,
      submit,
      isOpen: (screen) => /Select model/.test(screen),
      timeoutMs: 2_000,
      label: "test picker",
      nudgeDelayMs: 10,
    });
    expect(parseClaudeModelPicker(text).options.length).toBe(5);
    // The whole command was re-submitted, not just a bare Enter nudge.
    expect(submits).toBeGreaterThanOrEqual(2);
  });

  test("C-API-35 a rejected re-submit settles openCommandScreen with that error", async () => {
    // The picker never opens; the first nudge re-submit rejects (e.g. the
    // session closed while polling). openCommandScreen must reject with that
    // error immediately, not wait out the timeout or leak an unhandled reject.
    const terminal = scripted("still the composer");
    let submits = 0;
    const submit = () => {
      submits += 1;
      // First call (initial submit) resolves; the nudge re-submit rejects.
      return submits === 1 ? Promise.resolve() : Promise.reject(new Error("session_not_running"));
    };
    await expect(
      openCommandScreen({
        terminal,
        submit,
        isOpen: (screen) => /Select model/.test(screen),
        timeoutMs: 5_000,
        label: "test picker",
        nudgeDelayMs: 10,
      }),
    ).rejects.toThrow("session_not_running");
  });

  test("C-API-23 openCommandScreen does not re-submit once the picker is open", async () => {
    const terminal = scripted("booting");
    let submits = 0;
    const submit = () => {
      submits += 1;
      return Promise.resolve();
    };
    setTimeout(() => {
      terminal.text = claudePicker;
    }, 20);
    await openCommandScreen({
      terminal,
      submit,
      isOpen: (screen) => /Select model/.test(screen),
      timeoutMs: 2_000,
      label: "test picker",
      nudgeDelayMs: 60,
    });
    await new Promise((resolve) => setTimeout(resolve, 140));
    // Only the initial submit; no re-submit once the picker was already open.
    expect(submits).toBe(1);
  });

  test("C-API-23 pickerTimeout falls back to the 20s default", () => {
    expect(pickerTimeout()).toBe(20_000);
    expect(pickerTimeout({ timeoutMs: 5 })).toBe(5);
  });

  test("C-API-23 waitForScreen times out with model_automation_failed", async () => {
    const terminal = scripted("nothing to see");
    await expect(
      waitForScreen(terminal, (text) => text.includes("never"), 150, "a screen that never comes"),
    ).rejects.toMatchObject({ code: "model_automation_failed" });
  });
});
