/**
 * Coverage for the shared `[Image #N]` chip confirmation (PRD §5.3,
 * C-API-44/45/46): resolves on a count increase, rejects with
 * image_attach_failed on timeout or abort. Fake timers keep waits instant.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  imageChipCount,
  sendWhenUnblocked,
  waitForImageChip,
} from "../../src/core/images/chip-wait.ts";

const opts = { settleMs: 10, timeoutMs: 100, pollMs: 20 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("waitForImageChip (C-API-44)", () => {
  test("C-API-44 imageChipCount counts chips only on the composer prompt line", () => {
    expect(imageChipCount("")).toBe(0);
    // Chips on the composer prompt line (Codex `›`, Claude `❯`) count.
    expect(imageChipCount("› [Image #1] [Image #2]")).toBe(2);
    expect(imageChipCount("❯ [Image #1]")).toBe(1);
    // An empty composer prompt line (no chip yet) counts zero, not a crash.
    expect(imageChipCount("› ")).toBe(0);
    // A chip-like string on a NON-prompt line (assistant/transcript output) does not.
    const transcript = `assistant output: [Image #99]\n${"\n".repeat(20)}› composer`;
    expect(imageChipCount(transcript)).toBe(0);
  });

  test("C-API-44 does not confirm on a chip that appears only in non-composer output", async () => {
    // The chip string sits on an assistant line, never on the composer prompt line.
    const text = `assistant: [Image #1]${"\n".repeat(10)}› composer prompt`;
    const term = { sendInput: () => undefined, snapshot: () => ({ text }) };
    const done = waitForImageChip(term, 0, new AbortController().signal, opts);
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    await vi.runAllTimersAsync();
    await settled;
  });

  test("C-API-44 resolves once the chip count rises above before", async () => {
    let text = "";
    const term = { sendInput: () => undefined, snapshot: () => ({ text }) };
    const done = waitForImageChip(term, 0, new AbortController().signal, opts);
    text = "› [Image #1]";
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
  });

  test("C-API-44 rejects with image_attach_failed on timeout", async () => {
    const term = { sendInput: () => undefined, snapshot: () => ({ text: "" }) };
    const done = waitForImageChip(term, 0, new AbortController().signal, opts);
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    await vi.runAllTimersAsync();
    await settled;
  });

  test("C-API-44 rejects when aborted mid-wait", async () => {
    const term = { sendInput: () => undefined, snapshot: () => ({ text: "" }) };
    const controller = new AbortController();
    const done = waitForImageChip(term, 0, controller.signal, opts);
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    controller.abort();
    await vi.runAllTimersAsync();
    await settled;
  });
});

describe("sendWhenUnblocked (C-API-37)", () => {
  const term = { sendInput: vi.fn(), snapshot: () => ({ text: "" }) };

  test("C-API-37 sends immediately when nothing is blocking", async () => {
    term.sendInput.mockClear();
    await sendWhenUnblocked(term, "x", undefined, new AbortController().signal);
    expect(term.sendInput).toHaveBeenCalledWith("x");
  });

  test("C-API-37 holds while blocked, then sends once cleared", async () => {
    term.sendInput.mockClear();
    let blocked = true;
    const done = sendWhenUnblocked(term, "x", () => blocked, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(200);
    expect(term.sendInput).not.toHaveBeenCalled();
    blocked = false;
    await vi.runAllTimersAsync();
    await done;
    expect(term.sendInput).toHaveBeenCalledWith("x");
  });

  test("C-API-37 rejects with image_attach_failed if aborted while blocked", async () => {
    term.sendInput.mockClear();
    const controller = new AbortController();
    const done = sendWhenUnblocked(term, "x", () => true, controller.signal);
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    controller.abort();
    await vi.runAllTimersAsync();
    await settled;
    expect(term.sendInput).not.toHaveBeenCalled();
  });

  test("C-API-37 does NOT write when abort lands as the dialog clears in the same poll", async () => {
    term.sendInput.mockClear();
    const controller = new AbortController();
    let blocked = true;
    const done = sendWhenUnblocked(term, "x", () => blocked, controller.signal);
    // Simulate the race: within the same sleep the dialog clears AND the signal aborts.
    blocked = false;
    controller.abort();
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    await vi.runAllTimersAsync();
    await settled;
    expect(term.sendInput).not.toHaveBeenCalled(); // the post-loop recheck caught it
  });
});
