/** Recovery distinguishes the live draft from submitted history (C-API-31). */
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
  test.each(
    (agent === "codex"
      ? ["probe prompt", "anything", "Ask Codex to do anything"]
      : ["probe prompt"]
    ).flatMap((payload) => [false, true].map((history) => ({ history, payload }))),
  )(`C-API-31 ${agent} recovery excludes submitted history=$history for $payload`, async ({
    history,
    payload,
  }) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      initialSize: { cols: 200, rows: 35 },
    });
    const pty = helper.ptys[0]!;
    const caret = agent === "claude" ? "❯" : "›";
    const text = agent === "claude" ? "[Pasted text #1 +15 lines]" : payload;
    const idle = agent === "claude" ? claudeComposer : codexSmallComposer;
    const draft = idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} ${text}`);
    const paint = (frame: string, staged: boolean) => {
      const row = frame.split("\n").findLastIndex((line) => line.startsWith(caret));
      const column = staged ? text.length + 2 : 2;
      pty.emitData(
        `\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(frame)}\u001b[${row + 1};${column + 1}H`,
      );
    };
    const write = pty.write.bind(pty);
    vi.spyOn(pty, "write").mockImplementation((value) => {
      write(value);
      if (String(value).startsWith("\u001b[200~")) paint(draft, true);
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
      const sent = session.sendMessage(payload);
      await vi.advanceTimersByTimeAsync(200);
      await sent;
      paint(history ? `${caret} ${text}\nPrior response\n${idle}` : draft, !history);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(history ? 1 : 2);
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
