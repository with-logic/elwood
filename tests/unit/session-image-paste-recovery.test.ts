/** Recovery from synthetic, already-staged image chips on both adapters (C-API-31/44). */
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

test.each([
  ["claude", "", false],
  ["claude", " \t\n", false],
  ["codex", "", false],
  ["codex", " \t\n", false],
  ["claude", "", true],
  ["codex", "", true],
] as const)("C-API-31/44 %s synthetic staged chip text=%j accepted=%s", async (agent, text, accepted) => {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  const cwd = helper.tempDir();
  const session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
  const pty = helper.ptys[0]!;
  const empty = agent === "claude" ? claudeComposer : codexSmallComposer;
  const caret = agent === "claude" ? "❯" : "›";
  const draft = empty.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} [Image #1]`);
  const paint = (frame: string) =>
    pty.emitData(`\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(frame)}`);
  const write = pty.write.bind(pty);
  vi.spyOn(pty, "write").mockImplementation((data) => {
    write(data);
    if (String(data).startsWith("\u001b[200~")) paint(draft);
    // A confirmed image remains visible after the native first Enter is swallowed.
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
    const sent = session.sendMessage(text);
    void sent.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(500);
    await sent;
    if (accepted) {
      // Constructed working frame: submitted image history, no newer composer.
      paint(`${caret} [Image #1]\n• Working (1s · esc to interrupt)`);
      pty.emitData("\u001b]0;⠋ Working\u0007\u001b[?25l");
    }
    expect(session.terminal.snapshot().text).toContain(`${caret} [Image #1]`);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(accepted ? 1 : 2);
    // A submitted image remains in history above a separately painted empty composer.
    paint(`${caret} [Image #1]\n${empty}`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(accepted ? 1 : 2);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
