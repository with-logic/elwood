/**
 * Coverage for Codex image attach (PRD §5.3, C-API-46): the clipboard is
 * snapshotted, each image is set + Ctrl+V'd + waited for its chip, and the prior
 * clipboard is restored — plus the macOS-only `unsupported_platform` guard and
 * clipboard restoration on a mid-attach failure. The clipboard module is stubbed
 * so this stays hermetic; the real NSPasteboard round-trip is covered elsewhere.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = {
  supported: true,
  prior: "prior-text",
  setCalls: [] as string[],
  restored: [] as string[],
  setThrows: false,
};

vi.mock("../../src/core/images/index.ts", () => ({
  clipboardImageSupported: () => state.supported,
  snapshotClipboardText: () => state.prior,
  restoreClipboardText: (text: string) => state.restored.push(text),
  setClipboardImage: (path: string) => {
    state.setCalls.push(path);
    if (state.setThrows) throw new Error("bad image");
  },
}));

const { attachCodexImages } = await import("../../src/codex/attach-images.ts");
const CTRL_V = String.fromCharCode(22);

beforeEach(() => {
  vi.useFakeTimers();
  state.supported = true;
  state.prior = "prior-text";
  state.setCalls = [];
  state.restored = [];
  state.setThrows = false;
});
afterEach(() => vi.useRealTimers());

function fakeTerminal(chipsPerPaste = 1) {
  const writes: string[] = [];
  let chips = 0;
  return {
    writes,
    sendInput(data: string): void {
      writes.push(data);
      chips += chipsPerPaste;
    },
    snapshot() {
      return { text: Array.from({ length: chips }, (_, i) => `[Image #${i + 1}]`).join(" ") };
    },
  };
}

describe("attachCodexImages (C-API-46)", () => {
  test("C-API-46 sets each image, sends Ctrl+V, and restores the prior clipboard", async () => {
    const term = fakeTerminal();
    const done = attachCodexImages(
      term,
      ["/abs/a.png", "/abs/b.png"],
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await done;
    expect(state.setCalls).toEqual(["/abs/a.png", "/abs/b.png"]);
    expect(term.writes).toEqual([CTRL_V, CTRL_V]);
    expect(state.restored).toEqual(["prior-text"]);
  });

  test("C-API-46 rejects with unsupported_platform on non-macOS without touching the clipboard", async () => {
    state.supported = false;
    const term = fakeTerminal();
    await expect(
      attachCodexImages(term, ["/abs/a.png"], new AbortController().signal),
    ).rejects.toMatchObject({ code: "unsupported_platform" });
    expect(state.setCalls).toEqual([]);
    expect(state.restored).toEqual([]);
  });

  test("C-API-46 restores the clipboard even when setClipboardImage throws", async () => {
    state.setThrows = true;
    const term = fakeTerminal();
    // setClipboardImage throws before any timer wait, so the promise rejects
    // synchronously — assert it directly without advancing fake timers.
    await expect(
      attachCodexImages(term, ["/abs/a.png"], new AbortController().signal),
    ).rejects.toThrow(/bad image/);
    expect(state.restored).toEqual(["prior-text"]); // finally restored the snapshot
  });

  test("C-API-46 proceeds when the chip never appears, then restores", async () => {
    const term = fakeTerminal(0);
    const done = attachCodexImages(term, ["/abs/a.png"], new AbortController().signal);
    await vi.runAllTimersAsync();
    await done;
    expect(term.writes).toEqual([CTRL_V]);
    expect(state.restored).toEqual(["prior-text"]);
  });

  test("C-API-46 stops before any image when already aborted, still restores", async () => {
    const term = fakeTerminal();
    const controller = new AbortController();
    controller.abort();
    const done = attachCodexImages(term, ["/abs/a.png"], controller.signal);
    await vi.runAllTimersAsync();
    await done;
    expect(state.setCalls).toEqual([]);
    expect(state.restored).toEqual(["prior-text"]);
  });

  test("C-API-46 aborts the chip wait mid-loop", async () => {
    const term = fakeTerminal(0);
    const controller = new AbortController();
    const done = attachCodexImages(term, ["/abs/a.png"], controller.signal);
    controller.abort();
    await vi.runAllTimersAsync();
    await done;
    expect(term.writes).toEqual([CTRL_V]);
  });
});
