/**
 * Conformance tests for Codex image attachment through a real session (PRD §5.3,
 * C-API-44/46): a message with images drives Ctrl+V per image before the text.
 * The macOS clipboard is STUBBED so the default suite never mutates the global
 * clipboard (which would flake under parallel test files); the real NSPasteboard
 * round-trip is exercised by the serial e2e (C-E2E-13).
 */

import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const clip = { set: [] as string[], restored: [] as string[], restoreOk: true };
vi.mock("../../src/codex/clipboard.ts", () => ({
  clipboardImageSupported: () => true,
  snapshotClipboardText: () => Promise.resolve("prior"),
  restoreClipboardText: (t: string) => {
    clip.restored.push(t);
    return Promise.resolve(clip.restoreOk);
  },
  setClipboardImage: (p: string) => {
    clip.set.push(p);
    return Promise.resolve();
  },
}));

const { startCodex } = await import("../../src/index.ts");
const { becomeReady, installFakes, ptys, resetFakes, tempDir } = await import("./helpers.ts");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ESC = String.fromCharCode(27);
const CTRL_V = String.fromCharCode(22);
const paste = (t: string) => `${ESC}[200~${t}${ESC}[201~`;

afterEach(() => {
  resetFakes();
  clip.set = [];
  clip.restored = [];
  clip.restoreOk = true;
});

/** Emit the `[Image #1]` chip once the Ctrl+V lands so the attach wait resolves. */
function driveChip(): void {
  const tick = () => {
    if (ptys[0]!.writes.includes(CTRL_V)) ptys[0]!.emitData(`[999;1H[K› [Image #1]`);
    else setTimeout(tick, 20);
  };
  setTimeout(tick, 20);
}

describe("CodexSession image attachment (C-API-44/46)", () => {
  for (const method of ["sendMessage", "sendPrompt", "sendGuidance"] as const) {
    test(`C-API-46 ${method} sets the image, sends Ctrl+V, then the text`, async () => {
      const cwd = tempDir();
      installFakes();
      const img = join(cwd, "shot.png");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(img, PNG);
      const session = await startCodex({ cwd });
      const queued = session[method]("describe", { images: [{ path: img }] });
      await becomeReady(session.elwoodSessionId, cwd);
      driveChip();
      await queued;
      expect(clip.set).toHaveLength(1);
      expect(ptys[0]!.writes[0]).toBe(CTRL_V);
      expect(ptys[0]!.writes.indexOf(paste("describe"))).toBeGreaterThan(0);
      expect(clip.restored).toEqual(["prior"]); // prior clipboard restored
    });
  }

  test("C-API-44 an unreadable image rejects the whole submission", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const promise = session.sendMessage("x", { images: [{ path: join(cwd, "missing.png") }] });
    // Attach the rejection handler BEFORE driving readiness (validation rejects at
    // dispatch), so the rejection is never momentarily unhandled.
    const settled = expect(promise).rejects.toMatchObject({ code: "invalid_image" });
    await becomeReady(session.elwoodSessionId, cwd);
    await settled;
    expect(ptys[0]!.writes).toEqual([]);
    expect(clip.set).toEqual([]); // never touched the clipboard
  });

  test("C-API-46 records a content-free clipboard_restore_failed warning on restore failure", async () => {
    clip.restoreOk = false;
    const cwd = tempDir();
    installFakes();
    const img = join(cwd, "shot.png");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(img, PNG);
    const session = await startCodex({ cwd });
    const queued = session.sendMessage("describe", { images: [{ path: img }] });
    await becomeReady(session.elwoodSessionId, cwd);
    driveChip();
    await queued;
    const warning = session.warnings.find((w) => w.code === "clipboard_restore_failed");
    expect(warning).toBeDefined();
    expect(warning?.raw).toBe("clipboard_restore_failed"); // content-free, no clipboard data
  });
});
