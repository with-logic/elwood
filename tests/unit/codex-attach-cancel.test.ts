/** Cancel clipboard waiters promptly while retaining active cleanup (PRD §5.3, C-API-46). */
import { expect, test, vi } from "vitest";
import { withClipboardLock } from "../../src/codex/images/clipboard-lock.ts";

const state = { snapshots: 0, restores: 0, restore: Promise.resolve() };
vi.mock("../../src/codex/images/clipboard.ts", () => ({
  clipboardImageSupported: () => true,
  snapshotClipboardText: () => {
    state.snapshots += 1;
    return Promise.resolve("prior");
  },
  setClipboardImage: () => Promise.resolve(),
  restoreClipboardText: async () => {
    state.restores += 1;
    await state.restore;
    return true;
  },
}));
const { attachCodexImages } = await import("../../src/codex/images/attach.ts");

const terminal = {
  settled: () => Promise.resolve(),
  renderFailed: false,
  sendInput: vi.fn(),
  snapshot: () => ({ text: "› " }),
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("C-API-46 cancelled clipboard waiter settles before another session releases its lease", async () => {
  const held = Promise.withResolvers<void>();
  const owner = withClipboardLock(() => held.promise);
  const abort = new AbortController();
  let settled = false;
  const waiting = attachCodexImages(terminal, ["/image.png"], abort.signal).catch(
    (error: unknown) => {
      settled = true;
      expect(error).toMatchObject({ code: "image_attach_failed" });
    },
  );
  // Past the write hold, the attach now waits for the lease.
  await tick();
  abort.abort();
  await tick();
  try {
    expect(settled).toBe(true);
    expect(state.snapshots).toBe(0);
    expect(terminal.sendInput).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    await Promise.all([owner, waiting]);
  }
});

test("C-API-46 active cancellation waits for clipboard restoration before settling", async () => {
  const restore = Promise.withResolvers<void>();
  state.restore = restore.promise;
  state.restores = 0;
  const abort = new AbortController();
  let settled = false;
  // A dialog appears once the attach owns the clipboard; a hold before that waits outside it.
  const dialog = () => state.snapshots > 0;
  const attach = attachCodexImages(terminal, ["/image.png"], abort.signal, dialog).catch(() => {
    settled = true;
  });
  await tick();
  abort.abort();
  await vi.waitFor(() => expect(state.restores).toBe(1));
  try {
    expect(settled).toBe(false);
    expect(terminal.sendInput).not.toHaveBeenCalled(); // no Ctrl+V reached the dialog
  } finally {
    restore.resolve();
    await attach;
  }
  expect(settled).toBe(true);
});
