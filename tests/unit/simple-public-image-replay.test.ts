/** Whole-prompt replay reattaches captured image bytes through real adapters (C-API-44/48). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import { AgentSessionBase } from "../../src/runtime/session/base.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { claudeComposer, codexSmallComposer, tty } from "../fixtures/trust-composer.ts";

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
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
  clipboard.path = "";
});
const image = (tag: number) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag]);

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-48 ${agent} public image replay repeats attachment bytes and ordering`, async () => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const options = { cwd, initialSize: { cols: 200, rows: 35 } };
    const facade = agent === "claude" ? new ClaudeSession(options) : new CodexSession(options);
    const raw = await facade.start();
    if (!(raw instanceof AgentSessionBase)) throw new Error("Expected actual adapter");
    const pty = helper.ptys[0]!;
    const attached: Buffer[] = [];
    const order: string[] = [];
    const caret = agent === "claude" ? "❯" : "›";
    const idle =
      (agent === "claude" ? claudeComposer : codexSmallComposer) +
      (agent === "claude" ? "\n◐ medium · /effort" : "");
    const paint = (count: number) => {
      const chips = Array.from({ length: count }, (_, i) => `[Image #${i + 1}]`).join(" ");
      const frame = count
        ? idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} ${chips}`)
        : idle;
      const row = frame.split("\n").findLastIndex((line) => line.startsWith(caret));
      pty.emitData(
        `\u001b[2J\u001b[H${tty(frame)}\u001b[${row + 1};${count ? chips.length + 3 : 3}H\u001b[?25h`,
      );
      return raw.terminal.settled();
    };
    const write = pty.write.bind(pty);
    vi.spyOn(pty, "write").mockImplementation((value) => {
      write(value);
      const path =
        value === "\u0016"
          ? clipboard.path
          : String(value)
              .slice(6, -6)
              .match(/^(.+elwood-image-.+\.png)$/)?.[1];
      if (path) {
        attached.push(readFileSync(path));
        order.push(`image${((attached.length - 1) % 2) + 1}`);
        void paint(((attached.length - 1) % 2) + 1);
      } else if (value === "\u001b[200~replay these images\u001b[201~") order.push("text");
      else if (value === "\r") order.push("enter");
    });
    let result: Promise<string> | undefined;
    try {
      if (agent === "claude")
        await pty.dispatchHook(raw.elwoodSessionId, {
          hook_event_name: "InstructionsLoaded",
          session_id: "claude-1",
          cwd,
          file_path: "/tmp/CLAUDE.md",
          memory_type: "Project",
          load_reason: "session_start",
        });
      else await codex.becomeReady(raw.elwoodSessionId, cwd);
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
      await pty.dispatchHook(raw.elwoodSessionId, {
        hook_event_name: "UserPromptSubmit",
        session_id: `${agent}-1`,
        cwd,
        prompt: "replay these images",
        turn_id: "replayed-image-turn",
      });
      await paint(0);
      await pty.dispatchHook(raw.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        stop_hook_active: false,
        last_assistant_message: "",
        turn_id: "replayed-image-turn",
      });
      await expect(result).resolves.toBe("");
      expect(order).toHaveLength(8);
    } finally {
      await facade.close();
      if (result) await Promise.allSettled([result]);
    }
  }, 15_000);
}
