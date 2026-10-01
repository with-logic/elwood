/** Whole-prompt replay reattaches captured image bytes through real adapters (C-API-44/48). */

import { afterEach, expect, test, vi } from "vitest";
import { AgentSessionBase } from "../../src/runtime/session/base.ts";
import { attachedImage } from "../fixtures/owned-turn/attachments.ts";
import { imageComposer } from "../fixtures/owned-turn/composer.ts";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";

const clipboard = vi.hoisted(() => ({ path: "" }));
vi.mock("../../src/codex/images/clipboard.ts", async (original) => ({
  ...(await original<typeof import("../../src/codex/images/clipboard.ts")>()),
  clipboardImageSupported: () => true,
  snapshotClipboardText: () => Promise.resolve("old clipboard"),
  setClipboardImage: (path: string) => {
    clipboard.path = path;
    return Promise.resolve();
  },
  restoreClipboardText: () => Promise.resolve(true),
}));
afterEach(() => {
  resetAdapters();
  clipboard.path = "";
});
const image = (tag: number) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag]);

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-48 ${agent} public image replay repeats attachment bytes and ordering`, async () => {
    const { helper, cwd, facade } = createFacadeFixture(agent, {
      initialSize: { cols: 200, rows: 35 },
    });
    const raw = await facade.start();
    if (!(raw instanceof AgentSessionBase)) throw new Error("Expected actual adapter");
    const pty = helper.ptys[0]!;
    const native = nativeHooks(agent, raw, cwd, pty);
    const attached: Buffer[] = [];
    const order: string[] = [];
    const paint = (count: number) => {
      const chips = Array.from({ length: count }, (_, i) => `[Image #${i + 1}]`).join(" ");
      pty.emitData(imageComposer(agent, chips, true, ""));
      return raw.terminal.settled();
    };
    const write = pty.write.bind(pty);
    vi.spyOn(pty, "write").mockImplementation((value) => {
      write(value);
      const attachment = attachedImage(value, clipboard.path);
      if (attachment) {
        attached.push(attachment.bytes);
        order.push(`image${((attached.length - 1) % 2) + 1}`);
        void paint(((attached.length - 1) % 2) + 1);
      } else if (value === "\u001b[200~replay these images\u001b[201~") order.push("text");
      else if (value === "\r") order.push("enter");
    });
    let result: Promise<string> | undefined;
    try {
      await native.ready();
      await raw.waitForStatus((status) => status === "ready", 5_000);
      const first = image(1);
      const second = image(2);
      result = facade.send("replay these images", {
        images: [
          { data: first, format: "png" },
          { data: second, format: "png" },
        ],
        timeoutMs: 12_000,
      });
      void result.catch(() => undefined);
      first.fill(0);
      second.fill(0);
      await expect
        .poll(() => order, { timeout: 5_000 })
        .toEqual(["image1", "image2", "text", "enter"]);
      // The composer consumed the initial write, but no native acceptance happened.
      // This is the actual public recovery trigger, not a manual replay submission.
      await paint(0);
      raw.submitEvidence("hook_turn_ended");
      await expect
        .poll(() => order, { timeout: 5_000 })
        .toEqual(["image1", "image2", "text", "enter", "image1", "image2", "text", "enter"]);
      expect(attached).toEqual(
        [image(1), image(2), image(1), image(2)].map((bytes) => Buffer.from(bytes)),
      );
      await native.submit("replayed-image-turn", "replay these images");
      await paint(0);
      await native.stop("replayed-image-turn");
      await expect(result).resolves.toBe("");
      expect(order).toHaveLength(8);
    } finally {
      await facade.close();
      if (result) await Promise.allSettled([result]);
    }
  }, 15_000);
}
