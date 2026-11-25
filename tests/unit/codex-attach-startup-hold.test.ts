/**
 * A held Codex image attach waits before the process-wide clipboard lock (PRD §5.3,
 * C-API-28, C-API-46). A startup screen can hold a pre-readiness write for minutes;
 * holding the lock meanwhile would stall every other session's attach, with this image
 * on the user's clipboard. The clipboard module is stubbed hermetically.
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const calls: string[] = [];

vi.mock("../../src/codex/images/clipboard.ts", () => ({
  clipboardImageSupported: () => true,
  snapshotClipboardText: () => {
    calls.push("snapshot");
    return Promise.resolve("prior-text");
  },
  restoreClipboardText: () => {
    calls.push("restore");
    return Promise.resolve(true);
  },
  setClipboardImage: (path: string) => {
    calls.push(`set ${path}`);
    return Promise.resolve();
  },
}));

const { attachCodexImages } = await import("../../src/codex/images/attach.ts");
const { withClipboardLock } = await import("../../src/codex/images/clipboard-lock.ts");
const { unsafeWriteRetryMs } = await import("../../src/core/input/constants.ts");
const CTRL_V = String.fromCharCode(22);

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
});
afterEach(() => vi.useRealTimers());

/** A composer that shows one more image chip after every write. */
function chipTerminal() {
  const writes: string[] = [];
  return {
    writes,
    settled: () => Promise.resolve(),
    renderFailed: false,
    sendInput(data: string): void {
      writes.push(data);
    },
    snapshot() {
      const chips = writes.map((_, i) => `[Image #${i + 1}]`).join(" ");
      return { text: `› ${chips}` };
    },
  };
}

test("C-API-46 a held attach leaves the clipboard and its lock free until the hold clears", async () => {
  let held = true;
  const terminal = chipTerminal();
  const signal = new AbortController().signal;
  const attached = attachCodexImages(terminal, ["/a.png"], signal, () => held);
  await vi.advanceTimersByTimeAsync(unsafeWriteRetryMs * 4);
  let otherAttachRan = false;
  void withClipboardLock(() => {
    otherAttachRan = true;
    return Promise.resolve();
  });
  await vi.advanceTimersByTimeAsync(unsafeWriteRetryMs);
  expect(otherAttachRan).toBe(true);
  expect(calls).toEqual([]);
  expect(terminal.writes).toEqual([]);

  held = false;
  await vi.runAllTimersAsync();
  await attached;
  expect(calls).toEqual(["snapshot", "set /a.png", "restore"]);
  expect(terminal.writes).toEqual([CTRL_V]);
});

test("C-API-46 an attach closed during the hold never touches the clipboard", async () => {
  const terminal = chipTerminal();
  const close = new AbortController();
  const attached = attachCodexImages(terminal, ["/a.png"], close.signal, () => true);
  const rejected = expect(attached).rejects.toMatchObject({ code: "image_attach_failed" });
  await vi.advanceTimersByTimeAsync(unsafeWriteRetryMs * 4);
  close.abort();
  await vi.runAllTimersAsync();
  await rejected;
  expect(calls).toEqual([]);
  expect(terminal.writes).toEqual([]);
});

test("C-API-46 a dialog that appears while an attach waits for the lock sends it back outside", async () => {
  let dialog = false;
  const terminal = chipTerminal();
  const signal = new AbortController().signal;
  const owner = Promise.withResolvers<void>();
  void withClipboardLock(() => owner.promise);
  const attached = attachCodexImages(terminal, ["/a.png"], signal, () => dialog);
  // Past the check outside the lock, the attach now waits for the other holder.
  await vi.advanceTimersByTimeAsync(unsafeWriteRetryMs);
  dialog = true;
  owner.resolve();
  await vi.advanceTimersByTimeAsync(unsafeWriteRetryMs * 4);
  let otherAttachRan = false;
  void withClipboardLock(() => {
    otherAttachRan = true;
    return Promise.resolve();
  });
  await vi.advanceTimersByTimeAsync(unsafeWriteRetryMs);
  expect(otherAttachRan).toBe(true);
  expect(calls).toEqual([]);
  expect(terminal.writes).toEqual([]);

  dialog = false;
  await vi.runAllTimersAsync();
  await attached;
  expect(calls).toEqual(["snapshot", "set /a.png", "restore"]);
  expect(terminal.writes).toEqual([CTRL_V]);
});
