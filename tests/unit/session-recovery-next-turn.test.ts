/** Hook completion before idle paint must not disable the next draft's recovery (C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";
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

for (const agent of ["claude", "codex"] as const)
  test.each([
    "queued",
    "ready-listener",
  ] as const)(`C-API-31 ${agent} %s successor recovers after Stop precedes idle paint`, async (arrival) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
    const pty = helper.ptys[0]!;
    const draft =
      agent === "claude"
        ? claudeComposer.replace(/^❯.*$/m, "❯ [Pasted text #1 +15 lines]")
        : codexSmallComposer.replace(/^›.*$/m, "› successor");
    const tty = agent === "claude" ? claudeTty : codexTty;
    const write = pty.write.bind(pty);
    let pastes = 0;
    vi.spyOn(pty, "write").mockImplementation((value) => {
      write(value);
      if (String(value).startsWith("\u001b[200~")) {
        const paint = () => pty.emitData(`\u001b[2J\u001b[H${tty(draft)}\u001b]0;Ready\u0007`);
        if (++pastes === 2) setTimeout(paint, 100);
        else paint();
      }
    });
    try {
      if (agent === "codex") await codex.becomeReady(session.elwoodSessionId, cwd);
      else
        await pty.dispatchHook(session.elwoodSessionId, {
          hook_event_name: "InstructionsLoaded",
          session_id: "claude-1",
          cwd,
          file_path: "/tmp/CLAUDE.md",
          memory_type: "Project",
          load_reason: "session_start",
        });
      vi.useFakeTimers();
      const first = session.sendMessage("first");
      await vi.advanceTimersByTimeAsync(200);
      await first;
      pty.emitData("\u001b]0;⠋ Working\u0007");
      await vi.advanceTimersByTimeAsync(50);
      expect(session.status).toBe("running");
      expect(session.terminal.title).toBe("⠋ Working");
      let next: Promise<void> | undefined;
      if (arrival === "queued") next = session.sendMessage("successor");
      else {
        const lifecycle: {
          on(event: "status", handler: (event: { status: ElwoodSessionStatus }) => void): unknown;
        } = session;
        lifecycle.on("status", ({ status }) => {
          if (status === "ready" && !next) next = session.sendMessage("successor");
        });
      }
      await pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        turn_id: "turn-1",
        stop_hook_active: false,
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(next).toBeDefined();
      await next;
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
