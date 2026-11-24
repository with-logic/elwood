/** A positive empty composer ends recovery even with submitted history (C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import { cancellableSubmission } from "../../src/core/input/submission-cancel.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import { ready } from "../claude/login-helpers.ts";
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

test("C-API-56 awaited Claude input needs a fresh PTY render at the software cursor", async () => {
  claude.installFakes();
  const cwd = claude.tempDir();
  const session = await startClaude({ cwd });
  const pty = claude.ptys[0]!;
  try {
    await ready(cwd, session);
    const input = claudeComposer.replace(/^❯.*$/m, "❯ \u001b[7m \u001b[27m");
    const composer = `\u001b[2J\u001b[H${claudeTty(input, false)}`;
    pty.emitData(composer);
    await session.terminal.settled();
    vi.useFakeTimers();
    const expected = ["\u001b[200~probe prompt\u001b[201~", "\r"];
    let consumed = false;
    const pending = session
      .sendMessage("probe prompt", cancellableSubmission(undefined, new AbortController().signal))
      .then(() => {
        consumed = true;
      });
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes).toEqual(expected);
    expect(consumed).toBe(false);

    const hostOutput = session.terminal.writeOutput("\u001b[0m");
    await vi.advanceTimersByTimeAsync(1_100);
    await hostOutput;
    expect(consumed).toBe(false);
    expect(pty.writes).toEqual(expected);

    pty.emitData(composer);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(consumed).toBe(true);
    await pending;
    expect(pty.writes).toEqual(expected);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    "staged",
    "unknown",
    "empty",
    "working-empty",
  ] as const)(`C-API-31 ${agent} recovery respects %s composer evidence`, async (frameKind) => {
    const payload = "probe prompt";
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
      const consumed = frameKind.endsWith("empty");
      paint(consumed ? `${caret} ${text}\nPrior response\n${idle}` : draft, !consumed);
      if (frameKind === "unknown") pty.emitData("\u001b[?25l");
      if (frameKind === "working-empty") pty.emitData("\u001b]0;⠋ Working\u0007");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(
        consumed || frameKind === "unknown" ? 1 : 2,
      );
      if (frameKind === "unknown") {
        paint(draft, true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(pty.writes.filter((value) => value === "\r")).toHaveLength(2);
      }
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
