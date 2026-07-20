/**
 * Coverage for the shared `[Image #N]` chip confirmation (PRD §5.3,
 * C-API-44/45/46): resolves on a count increase, rejects with
 * image_attach_failed on timeout or abort. Fake timers keep waits instant.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { imageChipCount, waitForImageChip } from "../../src/core/images/chip-wait.ts";

const opts = { settleMs: 10, timeoutMs: 100, pollMs: 20 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("waitForImageChip (C-API-44)", () => {
  test("C-API-44 imageChipCount counts chips", () => {
    expect(imageChipCount("")).toBe(0);
    expect(imageChipCount("[Image #1] and [Image #2]")).toBe(2);
  });

  test("C-API-44 resolves once the chip count rises above before", async () => {
    let text = "";
    const term = { sendInput: () => undefined, snapshot: () => ({ text }) };
    const done = waitForImageChip(term, 0, new AbortController().signal, opts);
    text = "[Image #1]";
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
