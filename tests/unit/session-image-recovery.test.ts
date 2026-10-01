/** Actual image attachment through both adapter sessions and live recovery (PRD §5.3). */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { claudeComposer, codexSmallComposer, tty } from "../fixtures/trust-composer.ts";

const clipboard = vi.hoisted(() => ({
  paths: [] as string[],
  restored: [] as string[],
  bytes: [] as Buffer[],
}));
vi.mock("../../src/codex/images/clipboard.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/codex/images/clipboard.ts")>()),
  clipboardImageSupported: () => true,
  snapshotClipboardText: () => Promise.resolve("prior clipboard"),
  setClipboardImage: (path: string) => {
    clipboard.bytes.push(readFileSync(path));
    clipboard.paths.push(path);
    return Promise.resolve();
  },
  restoreClipboardText: (value: string) => {
    clipboard.restored.push(value);
    return Promise.resolve(true);
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
  clipboard.paths = [];
  clipboard.bytes = [];
  clipboard.restored = [];
});
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (const agent of ["claude", "codex"] as const) {
  for (const text of ["", "  \t "] as const) {
    test.each([
      "fresh",
      "cached",
      "accepted",
      "working",
      "hidden",
      "dialog",
      "history",
      "failed-retry",
    ] as const)(`C-API-44 ${agent} attached image plus ${JSON.stringify(text)} recovery %s`, async (mode) => {
      const helper = agent === "claude" ? claude : codex;
      helper.installFakes();
      const cwd = helper.tempDir();
      const path = join(cwd, "image.png");
      writeFileSync(path, png);
      const session = await (agent === "claude" ? startClaude : startCodex)({
        cwd,
        initialSize: { cols: 200, rows: 35 },
      });
      const pty = helper.ptys[0]!;
      const caret = agent === "claude" ? "❯" : "›";
      const idle =
        (agent === "claude" ? claudeComposer : codexSmallComposer) +
        (agent === "claude" ? "\n◐ medium · /effort" : "");
      const chip = "[Image #1]";
      const draft = idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} ${chip}`);
      const paint = (frame = draft, hidden = false, title = "Ready") => {
        const row = frame.split("\n").findLastIndex((line) => line.startsWith(caret));
        pty.emitData(
          `\u001b[2J\u001b[H${tty(frame)}\u001b[${row + 1};${frame.split("\n")[row]?.includes(chip) ? chip.length + 3 : 3}H\u001b[?25${hidden ? "l" : "h"}\u001b]0;${title}\u0007`,
        );
      };
      let enters = 0;
      const write = pty.write.bind(pty);
      vi.spyOn(pty, "write").mockImplementation((value) => {
        if (value === "\r" && ++enters === 2 && mode === "failed-retry")
          throw new Error("intercept retry");
        write(value);
        if (value === "\u0016" || String(value).includes(path)) paint();
      });
      try {
        if (agent === "claude")
          await pty.dispatchHook(session.elwoodSessionId, {
            hook_event_name: "InstructionsLoaded",
            session_id: "claude-1",
            cwd,
            file_path: "/tmp/CLAUDE.md",
            memory_type: "Project",
            load_reason: "session_start",
          });
        else await codex.becomeReady(session.elwoodSessionId, cwd);
        await expect.poll(() => session.status).toBe("ready");
        vi.useFakeTimers();
        const sent = session.sendMessage(text, { images: [{ path }] });
        let submitted = false;
        void sent.then(
          () => {
            submitted = true;
          },
          () => {
            submitted = true;
          },
        );
        await vi.waitFor(() => expect(submitted).toBe(true));
        await sent;
        expect(enters).toBe(1);
        expect(pty.writes).toContain(`\u001b[200~${text}\u001b[201~`);
        if (agent === "claude") expect(pty.writes[0]).toBe(`\u001b[200~${path}\u001b[201~`);
        else {
          expect(clipboard.paths).toEqual([path]);
          expect(clipboard.bytes).toEqual([Buffer.from(png)]);
          expect(pty.writes[0]).toBe("\u0016");
          expect(clipboard.restored).toEqual(["prior clipboard"]);
        }
        if (mode === "accepted")
          await pty.dispatchHook(session.elwoodSessionId, {
            hook_event_name: "UserPromptSubmit",
            session_id: `${agent}-1`,
            cwd,
            model: "gpt-5.3-codex",
            turn_id: "own-turn",
            prompt: text,
          });
        // Cached pre-Enter chips cannot establish another physical attempt.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(enters).toBe(1);
        if (mode === "cached") session.terminal.resize({ cols: 199, rows: 35 });
        else if (mode === "dialog")
          paint(
            agent === "claude"
              ? "Do you want to create probe.txt?\n❯ 1. Yes\n  3. No\nEsc to cancel"
              : "Would you like to run the following command?\n› 1. Yes\n  2. No\nPress enter to confirm or esc to cancel",
          );
        else if (mode === "history") paint(`${caret} ${chip}\nPrior answer\n${idle}`);
        else paint(draft, mode === "hidden", mode === "working" ? "⠋ Working" : "Ready");
        await vi.advanceTimersByTimeAsync(1_000);
        const retry = mode === "fresh" || mode === "failed-retry";
        expect(enters).toBe(retry ? 2 : 1);
        // A successful or failed attempt consumes the same fresh-frame authority.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(enters).toBe(retry ? 2 : 1);
        // Keep the final history observation empty at the live cursor as well.
        paint(mode === "history" ? `${caret} ${chip}\nPrior answer\n${idle}` : draft);
        await vi.advanceTimersByTimeAsync(1_000);
        // A staged draft is not authoritative clearance for a retained native dialog hold.
        if (mode === "dialog") expect(session.status).toBe("blocked");
        expect(enters).toBe(retry ? 3 : ["accepted", "history", "dialog"].includes(mode) ? 1 : 2);
      } finally {
        vi.useRealTimers();
        await session.teardown();
      }
    });
  }
}
