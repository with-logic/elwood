/** Image attachment respects foreign model-picker ownership (PRD §5.3, C-API-44). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const clipboard = { images: [] as string[] };
vi.mock("../../src/codex/images/clipboard.ts", async (original) => ({
  ...(await original<typeof import("../../src/codex/images/clipboard.ts")>()),
  clipboardImageSupported: () => true,
  snapshotClipboardText: async () => "prior",
  restoreClipboardText: async () => true,
  setClipboardImage: (path: string) => {
    clipboard.images.push(path);
    return Promise.resolve();
  },
}));

const attachment = { entered: false };
vi.mock("../../src/codex/images/attach.ts", async (original) => {
  const actual = await original<typeof import("../../src/codex/images/attach.ts")>();
  return {
    ...actual,
    attachCodexImages: (...args: Parameters<typeof actual.attachCodexImages>) => {
      attachment.entered = true;
      return actual.attachCodexImages(...args);
    },
  };
});

const { startCodex } = await import("../../src/index.ts");
const { unsafeWriteRetryMs } = await import("../../src/core/input/constants.ts");
const { becomeReady, installFakes, ptys, resetFakes, tempDir } = await import("./helpers.ts");

import { codexTty } from "../fixtures/trust-composer.ts";

import { viewTerminalHistory } from "../helpers/live-buffer-fixture.ts";
import { asScreen, codexPickerCurrentMarkerOnly } from "../helpers/model-pickers.ts";

afterEach(() => {
  resetFakes();
  attachment.entered = false;
  clipboard.images = [];
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;

test("C-API-44 image and text wait for a live model picker while history stays selected", async () => {
  installFakes();
  const cwd = tempDir();
  const image = join(cwd, "shot.png");
  writeFileSync(image, png);
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    await viewTerminalHistory(session.terminal, ptys[0]!);
    ptys[0]!.emitData(asScreen(codexPickerCurrentMarkerOnly));
    await session.terminal.settled();
    const sent = session.sendMessage("caption", { images: [{ path: image }] });
    void sent.catch(() => undefined);
    // A held attach waits before the adapter attach runs, so the user's clipboard is
    // untouched and no image reaches the disk until the picker closes.
    await new Promise<void>((resolve) => setTimeout(resolve, unsafeWriteRetryMs * 2));
    expect(attachment.entered).toBe(false);
    expect(clipboard.images).toEqual([]);
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty("› Ask Codex to do anything\n  gpt-5.5 high")}`);
    await session.terminal.settled();
    await expect.poll(() => ptys[0]!.writes).toEqual(["\u0016"]);
    // The wrapper observed entry, then ran the real attachment implementation.
    expect(attachment.entered).toBe(true);
    expect(clipboard.images).toEqual([image]);
    ptys[0]!.emitData("\u001b[999;1H\u001b[K› [Image #1]");
    await sent;
    expect(session.terminal.snapshot().text).toContain("Historical output");
    expect(ptys[0]!.writes).toEqual(["\u0016", paste("caption"), "\r"]);
  } finally {
    await session.stop();
  }
});
