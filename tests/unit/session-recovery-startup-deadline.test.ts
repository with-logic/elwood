/** Continued startup work is not acceptance of the deadline-released prompt (C-API-31). */
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
  "claude",
  "codex",
] as const)("C-API-31 %s startup spinner survives deadline without revoking recovery", async (agent) => {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  const session = await (agent === "claude" ? startClaude : startCodex)({ cwd: helper.tempDir() });
  const pty = helper.ptys[0]!;
  const caret = agent === "claude" ? "❯" : "›";
  const payload = "probe prompt";
  const staged = agent === "claude" ? "[Pasted text #1 +15 lines]" : payload;
  const draft = (agent === "claude" ? claudeComposer : codexSmallComposer).replace(
    new RegExp(`^${caret}.*$`, "m"),
    `${caret} ${staged}`,
  );
  const paint = (frame: string, working: boolean) =>
    pty.emitData(
      `\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(frame)}\u001b]0;${working ? "⠋ Starting" : "Ready"}\u0007`,
    );
  const write = pty.write.bind(pty);
  vi.spyOn(pty, "write").mockImplementation((value) => {
    write(value);
    if (String(value).startsWith("\u001b[200~")) paint(draft, true);
  });
  try {
    vi.useFakeTimers();
    paint("Starting native tools", true);
    await vi.advanceTimersByTimeAsync(50);
    const sent = session.sendMessage(payload);
    await vi.advanceTimersByTimeAsync(10_200);
    await sent;
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
    paint(draft, false); // Startup finishes with the swallowed prompt still staged.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(2);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
