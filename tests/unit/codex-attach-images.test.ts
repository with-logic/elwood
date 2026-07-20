/**
 * Coverage for Codex image attach (PRD §5.3, C-API-46): the clipboard is
 * snapshotted once, each image is set + Ctrl+V'd + CONFIRMED by its chip, and the
 * prior clipboard is restored — plus the macOS-only guard, snapshot-failure
 * abort, and chip-timeout rejection. The clipboard module is stubbed hermetically.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = {
  supported: true,
  prior: "prior-text",
  snapshotThrows: false,
  setCalls: [] as string[],
  restored: [] as string[],
  setThrows: false,
};

vi.mock("../../src/codex/clipboard.ts", () => ({
  clipboardImageSupported: () => state.supported,
  snapshotClipboardText: () => {
    if (state.snapshotThrows) return Promise.reject(new Error("no clipboard"));
    return Promise.resolve(state.prior);
  },
  restoreClipboardText: (text: string) => {
    state.restored.push(text);
    return Promise.resolve();
  },
  setClipboardImage: (path: string) => {
    state.setCalls.push(path);
    return state.setThrows ? Promise.reject(new Error("bad image")) : Promise.resolve();
  },
}));

const { attachCodexImages } = await import("../../src/codex/attach-images.ts");
const CTRL_V = String.fromCharCode(22);

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(state, {
    supported: true,
    prior: "prior-text",
    snapshotThrows: false,
    setCalls: [],
    restored: [],
    setThrows: false,
  });
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
  test("C-API-46 sets each image, sends Ctrl+V, confirms, and restores the clipboard", async () => {
    const term = fakeTerminal();
    const done = attachCodexImages(term, ["/a.png", "/b.png"], new AbortController().signal);
    await vi.runAllTimersAsync();
    await done;
    expect(state.setCalls).toEqual(["/a.png", "/b.png"]);
    expect(term.writes).toEqual([CTRL_V, CTRL_V]);
    expect(state.restored).toEqual(["prior-text"]);
  });

  test("C-API-46 rejects unsupported_platform on non-macOS without touching the clipboard", async () => {
    state.supported = false;
    await expect(
      attachCodexImages(fakeTerminal(), ["/a.png"], new AbortController().signal),
    ).rejects.toMatchObject({ code: "unsupported_platform" });
    expect(state.setCalls).toEqual([]);
    expect(state.restored).toEqual([]);
  });

  test("C-API-46 aborts before mutating when the snapshot fails", async () => {
    state.snapshotThrows = true;
    await expect(
      attachCodexImages(fakeTerminal(), ["/a.png"], new AbortController().signal),
    ).rejects.toThrow(/no clipboard/);
    expect(state.setCalls).toEqual([]);
    expect(state.restored).toEqual([]); // never mutated → nothing to restore
  });

  test("C-API-46 restores the clipboard even when setClipboardImage throws", async () => {
    state.setThrows = true;
    await expect(
      attachCodexImages(fakeTerminal(), ["/a.png"], new AbortController().signal),
    ).rejects.toThrow(/bad image/);
    expect(state.restored).toEqual(["prior-text"]);
  });

  test("C-API-46 rejects image_attach_failed on chip timeout, still restoring", async () => {
    const term = fakeTerminal(0);
    const done = attachCodexImages(term, ["/a.png"], new AbortController().signal);
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    await vi.runAllTimersAsync();
    await settled;
    expect(state.restored).toEqual(["prior-text"]);
  });

  test("C-API-46 rejects when already aborted, still restoring", async () => {
    const controller = new AbortController();
    controller.abort();
    const done = attachCodexImages(fakeTerminal(), ["/a.png"], controller.signal);
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    await vi.runAllTimersAsync();
    await settled;
    expect(state.setCalls).toEqual([]);
    expect(state.restored).toEqual(["prior-text"]);
  });
});
