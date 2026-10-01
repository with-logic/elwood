/** Public image-only turns keep native draft and clone ownership through cleanup (C-API-44/48). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { sessionImageBudget } from "../../src/core/images/queued-budget.ts";
import { imageLimits } from "../../src/core/images/types.ts";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { claudeComposer, codexSmallComposer, tty } from "../fixtures/trust-composer.ts";

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
const limits = imageLimits as { maxQueuedBytes: number };
const realCeiling = limits.maxQueuedBytes;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
afterEach(() => {
  limits.maxQueuedBytes = realCeiling;
  clipboard.path = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-48 ${agent} image-only ${agent === "codex" ? "timeout" : "completion"} retains cleanup before the next attachment`, async () => {
    limits.maxQueuedBytes = png.length * 2;
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const options = { cwd, initialSize: { cols: 200, rows: 35 } };
    const facade = agent === "claude" ? new ClaudeSession(options) : new CodexSession(options);
    const raw = await facade.start();
    const pty = helper.ptys[0]!;
    const attached: Buffer[] = [];
    const caret = agent === "claude" ? "❯" : "›";
    const idle = agent === "claude" ? claudeComposer : codexSmallComposer;
    const paint = (chip: boolean) => {
      const frame = chip
        ? idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} [Image #1]`)
        : idle;
      const row = frame.split("\n").findLastIndex((line) => line.startsWith(caret));
      pty.emitData(`\u001b[2J\u001b[H${tty(frame)}\u001b[${row + 1};${chip ? 13 : 3}H\u001b[?25h`);
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
        paint(true); // respond only to an actual adapter attachment, not an invented chip
      }
    });
    let first: Promise<string> | undefined;
    let next: Promise<string> | undefined;
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
      await expect.poll(() => raw.status).toBe("ready");
      vi.useFakeTimers();
      const bytes = png.slice();
      first = facade.send("", {
        images: [{ data: bytes, format: "png" }],
        ...(agent === "codex" ? { timeoutMs: 2_000 } : {}),
      });
      const settled =
        agent === "codex"
          ? expect(first).rejects.toMatchObject({ code: "wait_timeout" })
          : expect(first).resolves.toBe("");
      bytes.fill(0);
      next = facade.send("next", { images: [{ data: png, format: "png" }] });
      void next.catch(() => undefined);
      await expect(
        facade.send("overflow", { images: [{ data: png, format: "png" }] }),
      ).rejects.toMatchObject({ code: "invalid_image" });
      await vi.waitFor(() => expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1));
      expect(attached).toEqual([Buffer.from(png)]);
      await pty.dispatchHook(raw.elwoodSessionId, {
        hook_event_name: "UserPromptSubmit",
        session_id: `${agent}-1`,
        cwd,
        prompt: "",
        turn_id: "image-turn",
      });
      if (agent === "claude")
        await pty.dispatchHook(raw.elwoodSessionId, {
          hook_event_name: "Stop",
          session_id: "claude-1",
          cwd,
          stop_hook_active: false,
          last_assistant_message: "",
          turn_id: "image-turn",
        });
      // Codex cannot complete from a retained image: timeout must still own cleanup.
      await vi.advanceTimersByTimeAsync(2_100);
      await settled;
      expect(pty.writes).toContain("\u0015\u000b");
      expect(attached).toHaveLength(1); // consumer settlement has not released its dirty input
      expect(() => sessionImageBudget(raw).reserve(1)).toThrow("Too many queued image bytes");
      paint(false); // only fresh empty input confirms the clear before the next attachment
      if (agent === "codex") {
        await vi.advanceTimersByTimeAsync(100);
        await pty.dispatchHook(raw.elwoodSessionId, {
          hook_event_name: "Stop",
          session_id: `${agent}-1`,
          cwd,
          stop_hook_active: false,
          last_assistant_message: "",
          turn_id: "image-turn",
        });
      }
      await vi.waitFor(() => expect(attached).toHaveLength(2));
      expect(attached[1]).toEqual(Buffer.from(png));
    } finally {
      vi.useRealTimers();
      await facade.close();
      await Promise.allSettled([first, next]);
    }
  });
}
