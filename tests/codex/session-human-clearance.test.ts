/** Partial and working frames retain trust-owned queued input (C-TRUST-01). */

import { afterEach, expect, test, vi } from "vitest";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { codexComposer, codexTrust, codexTty, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  ["resumed human gate partial replacement", true, tty("Unrecognized permission\n› Continue")],
  ["human gate partial replacement", false, tty("Unrecognized permission\n› Continue")],
  ["human gate title-only work", false, `\u001b]0;⠋ project\u0007${codexTty(codexComposer)}`],
  ["human gate bare caret", false, tty("› \n  gpt-5.5 high")],
  [
    "human gate partial approval over old composer",
    false,
    tty(
      `Would you like to run the following command?\n› 1. Yes, proceed\n  2. No\n${codexComposer}`,
    ),
  ],
  [
    "human gate erased welcome body",
    false,
    tty(
      codexComposer
        .slice(0, codexComposer.lastIndexOf("\n"))
        .replace(/^│ (?:model:|directory:).*$/gm, ""),
    ),
  ],
] as const)("C-TRUST-01 %s keeps caller input held", async (_name, resume, repaint) => {
  installFakes();
  const cwd = tempDir();
  const sessions: CodexSessionApi[] = [];
  try {
    let session = await startCodex({ cwd, autotrust: false });
    sessions.push(session);
    if (resume) {
      await ptys[0]!.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "SessionStart",
        session_id: "resume-human",
        cwd,
        transcript_path: "/tmp/missing-human-transcript",
        source: "startup",
      });
      await session.stop();
      session = await resumeCodex({
        cwd,
        elwoodSessionId: session.elwoodSessionId,
        autotrust: false,
      });
      sessions.push(session);
    }
    const pty = ptys.at(-1)!;
    const startup: string[] = [];
    session.on("activity", (event) => {
      if (event.kind === "startup_prompt") startup.push(event.kind);
    });
    vi.useFakeTimers();
    const queued = session.sendMessage("after trust");
    pty.emitData(tty(`${codexTrust}\n› 1. Yes, continue\n  2. No, quit`));
    await vi.advanceTimersByTimeAsync(6_000);
    const callerText = "\u001b[200~after trust\u001b[201~";
    expect(pty.writes).not.toContain(callerText);
    pty.emitData(`\u001b[2J\u001b[H${repaint}`);
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).not.toContain(callerText);
    expect(session.status).toBe("blocked");
    expect(pty.writes).toEqual([]);
    expect(startup).toEqual([]);
    await session.sendKeys("\u001b");
    expect(pty.writes).toContain("\u001b");
    expect(pty.writes).not.toContain(callerText);
    pty.emitData(`\u001b]0;project\u0007\u001b[2J\u001b[H${codexTty(codexComposer)}`);
    await vi.advanceTimersByTimeAsync(500);
    await queued;
    expect(
      session
        .statusDecisions()
        .filter((decision) => decision.evidence === "blocking_prompt_cleared"),
    ).toHaveLength(1);
    expect(pty.writes.filter((input) => input === callerText)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await Promise.all(sessions.map((session) => session.teardown()));
  }
});

test("C-TRUST-01 failed rendering keeps human trust input held after a later composer", async () => {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), autotrust: false });
  try {
    vi.useFakeTimers();
    const queued = session.sendMessage("after failed render");
    const settled = vi.fn();
    void queued.then(settled, settled);
    ptys[0]!.emitData(tty(`${codexTrust}\n› 1. Yes, continue\n  2. No, quit`));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(session.status).toBe("blocked");
    vi.spyOn(session.terminal.xterm, "write").mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    ptys[0]!.emitData("\u001b[2J\u001b[HReplacement dialog");
    await vi.advanceTimersByTimeAsync(500);
    expect(session.terminal.renderFailed).toBe(true);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.terminal.snapshot().text).toContain("› Ask Codex to do anything");
    expect(session.status).toBe("blocked");
    expect(ptys[0]!.writes).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
