/** Hook completion before idle paint must not disable the next draft's recovery (C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
});

test.each([
  "queued",
  "ready-listener",
] as const)("C-API-31 %s successor recovers after Stop precedes idle paint", async (arrival) => {
  claude.installFakes();
  const cwd = claude.tempDir();
  const session = await startClaude({ cwd });
  const pty = claude.ptys[0]!;
  const draft = claudeComposer.replace(/^❯.*$/m, "❯ [Pasted text #1 +15 lines]");
  const write = pty.write.bind(pty);
  vi.spyOn(pty, "write").mockImplementation((value) => {
    write(value);
    if (String(value).startsWith("\u001b[200~"))
      pty.emitData(`\u001b[2J\u001b[H${claudeTty(draft)}\u001b]0;Ready\u0007`);
  });
  try {
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
    else
      session.on("status", ({ status }) => {
        if (status === "ready" && !next) next = session.sendMessage("successor");
      });
    await pty.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
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
