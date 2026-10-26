/**
 * Conformance tests for an image attach cut short by its session closing (PRD §5.3,
 * §8.4, C-API-44): `stop`, `kill`, and `teardown` remove the attach's temp image before
 * they resolve, for both adapters, so a host that exits right after shutdown leaves no
 * `elwood-image-*` directory behind. No `[Image #N]` chip is ever painted, so each
 * attach is still waiting for confirmation when the shutdown starts. The Codex
 * clipboard is faked: these tests never touch the real macOS pasteboard.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

const clipboard = vi.hoisted(() => ({ path: "" }));
vi.mock("../../src/codex/images/clipboard.ts", async (original) => ({
  ...(await original<typeof import("../../src/codex/images/clipboard.ts")>()),
  clipboardImageSupported: () => true,
  snapshotClipboardText: () => Promise.resolve("previous clipboard"),
  setClipboardImage: (path: string) => {
    clipboard.path = path;
    return Promise.resolve();
  },
  restoreClipboardText: () => Promise.resolve(true),
}));

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_PATH = /(\/[\w./-]*elwood-image-[\w-]+\/[\w-]+\.png)/;

afterEach(() => {
  clipboard.path = "";
  claude.resetFakes();
  codex.resetFakes();
});

const adapters = [
  {
    agent: "claude",
    helpers: claude,
    start: async (cwd: string) => {
      const session = await startClaude({ cwd });
      await claude.ptys[0]!.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "InstructionsLoaded",
        session_id: "claude-image-shutdown",
        cwd,
        file_path: "/tmp/CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
      });
      return session;
    },
    // Claude reads the image from the absolute path Elwood pastes into the composer.
    attached: () => claude.ptys[0]!.writes.join("").match(IMAGE_PATH)?.[1] ?? "",
  },
  {
    agent: "codex",
    helpers: codex,
    start: async (cwd: string) => {
      const session = await startCodex({ cwd });
      await codex.becomeReady(session.elwoodSessionId, cwd);
      return session;
    },
    // Codex reads the image from the file Elwood lays on the (faked) clipboard.
    attached: () => clipboard.path,
  },
] as const;

for (const { agent, helpers, start, attached } of adapters) {
  describe(`${agent} image attach cut short by shutdown`, () => {
    test.each([
      "stop",
      "kill",
      "teardown",
    ] as const)(`C-API-44 ${agent} %s removes the in-flight attach's temp image before it resolves`, async (verb) => {
      helpers.installFakes();
      const session = await start(helpers.tempDir());
      await expect.poll(() => session.status).toBe("ready");
      const sent = session.sendMessage("look", { images: [{ data: png, format: "png" }] });
      sent.catch(() => undefined); // asserted below, after the shutdown
      await expect.poll(attached).toMatch(IMAGE_PATH);
      const file = attached();
      expect(existsSync(file)).toBe(true); // the attach is still waiting for its chip
      await session[verb]();
      expect(existsSync(dirname(file))).toBe(false);
      await expect(sent).rejects.toMatchObject({ code: "session_not_running" });
    });
  });
}
