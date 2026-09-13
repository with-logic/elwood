/**
 * Flow tests for the screen-polling primitives behind TUI automation: opening a slash-command
 * screen with re-submit nudges and bounded screen waits. Covers PRD §5.3, C-API-23, C-API-35.
 */

import { describe, expect, test, vi } from "vitest";
import { parseClaudeModelPicker } from "../../src/core/models/rows.ts";
import { openCommandScreen, waitForScreen } from "../../src/core/models/tui-screen.ts";
import { claudePicker } from "../helpers/model-pickers.ts";
import { scripted } from "./scripted-terminal.ts";

describe("tui-screen primitives", () => {
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
    vi.useFakeTimers();
    try {
      const terminal = scripted("booting");
      let submits = 0;
      const submit = () => {
        submits += 1;
        return Promise.resolve();
      };
      setTimeout(() => {
        terminal.text = claudePicker;
      }, 20);
      const opened = openCommandScreen({
        terminal,
        submit,
        isOpen: (screen) => /Select model/.test(screen),
        timeoutMs: 2_000,
        label: "test picker",
        nudgeDelayMs: 60,
      });
      // The picker opens at 20ms; the 60ms nudge tick sees it open, the 100ms poll returns.
      await vi.advanceTimersByTimeAsync(100);
      await opened;
      await vi.advanceTimersByTimeAsync(140);
      // Only the initial submit; no re-submit once the picker was already open.
      expect(submits).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("C-API-23 waitForScreen times out with model_automation_failed", async () => {
    const terminal = scripted("nothing to see");
    await expect(
      waitForScreen(terminal, (text) => text.includes("never"), 150, "a screen that never comes"),
    ).rejects.toMatchObject({ code: "model_automation_failed" });
  });
});

test("C-API-23 a late initial submission cannot arm retries after its deadline", async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    let signal!: AbortSignal;
    const submit = vi.fn((pending: AbortSignal) => {
      signal = pending;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const result = openCommandScreen({
      terminal: scripted("blocked"),
      submit,
      isOpen: () => false,
      timeoutMs: 100,
      label: "picker",
      nudgeDelayMs: 10,
    });
    const check = expect(result).rejects.toMatchObject({ code: "model_automation_failed" });
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(signal.aborted).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submit).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
