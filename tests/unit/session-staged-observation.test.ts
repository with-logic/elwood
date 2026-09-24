/** Unverifiable native input does not prove consumption (C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import {
  claudeComposer,
  claudeTty,
  codexSmallComposer,
  codexTty,
} from "../fixtures/trust-composer.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    "hidden",
    "unknown",
    "consumed",
    "bounded",
    "bounded-dialog",
    "raw",
    "working",
    "pre-ready-working",
    "history",
    "old-empty",
    "consumed-working",
  ] as const)(`C-API-31 ${agent} recovery distinguishes %s input observation`, async (state) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      initialSize: { cols: 200, rows: 35 },
    });
    const pty = helper.ptys[0]!;
    const caret = agent === "claude" ? "❯" : "›";
    const text = agent === "claude" ? "[Pasted text #1 +15 lines]" : "probe prompt";
    const dialog =
      agent === "claude"
        ? "Do you want to create probe.txt?\n❯ 1. Yes\n  3. No\nEsc to cancel"
        : "Would you like to run the following command?\n› 1. Yes\n  2. No\nPress enter to confirm or esc to cancel";
    const idle = agent === "claude" ? claudeComposer : codexSmallComposer;
    const draft = idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} ${text}`);
    const paint = (frame = draft, hidden = false, title = "Ready") => {
      const row = frame.split("\n").findLastIndex((line) => line.startsWith(caret));
      pty.emitData(
        `\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(frame)}\u001b[${row + 1};${frame === idle ? 3 : text.length + 3}H\u001b[?25${hidden ? "l" : "h"}\u001b]0;${title}\u0007`,
      );
    };
    const write = pty.write.bind(pty);
    vi.spyOn(pty, "write").mockImplementation((value) => {
      write(value);
      if (String(value).startsWith("\u001b[200~") && state !== "old-empty") paint();
    });
    try {
      if (state !== "pre-ready-working") {
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
      }
      vi.useFakeTimers();
      if (state === "old-empty") {
        paint(idle);
        await vi.advanceTimersByTimeAsync(50);
      }
      const sent = session.sendPrompt("probe prompt");
      await vi.advanceTimersByTimeAsync(200);
      await sent;
      if (state !== "old-empty")
        paint(
          state.endsWith("dialog")
            ? dialog
            : state.startsWith("consumed")
              ? idle
              : state === "history"
                ? `${caret} ${text}\nPrior answer\n${draft.replace(text, "other draft")}`
                : state === "unknown"
                  ? `${draft}\nUnknown overlay`
                  : draft,
          state === "hidden" || state === "bounded" || state === "raw",
          state.endsWith("working") ? "⠋ Working" : "Ready",
        );
      await vi.advanceTimersByTimeAsync(state.startsWith("bounded") ? 5_000 : 1_000);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
      if (state === "raw") await session.sendKeys("caller edit");
      paint();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(
        state.startsWith("consumed") || state.startsWith("bounded") || state === "raw" ? 1 : 2,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(
        state.startsWith("consumed") || state.startsWith("bounded") || state === "raw" ? 1 : 3,
      );
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
