/**
 * Overlapping-shutdown coverage for Claude sessions (PRD §5.3/§9.4, C-LIFE-10):
 * concurrent stop/kill/teardown signal the PTY at most once and settle on the
 * correct terminal status. All kills go through injected fakes — no real signal.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession overlapping shutdown", () => {
  test("C-LIFE-10 concurrent stop + stop signals the PTY once and settles stopped", async () => {
    // Overlapping shutdowns must not each snapshot a non-terminal status and race
    // into terminatePty: the coordinator lets the first own the shutdown and the
    // second JOIN it, so the PTY is signaled exactly once.
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const pty = ptys.at(-1)!;
    reapedGroups.length = 0;
    await Promise.all([session.stop(), session.stop()]);
    expect(pty.killSignals).toEqual(["SIGTERM"]); // signaled at most once
    expect(session.status).toBe("stopped");
    expect(reapedGroups.filter((pid) => pid === pty.pid)).toEqual([pty.pid]); // reaped once
  });

  test("C-LIFE-10 stop then kill signals the PTY once; a kill escalation does not re-signal", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const pty = ptys.at(-1)!;
    await Promise.all([session.stop(), session.kill()]);
    // stop drove the PTY to exit (stopped); the kill escalation observes the terminal
    // status and performs only the one-shot reap — it never re-signals the dead PTY.
    expect(pty.killSignals).toEqual(["SIGTERM"]);
    expect(session.status).toBe("stopped");
  });

  test("C-LIFE-10 concurrent kill + kill signals the PTY once and settles killed", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const pty = ptys.at(-1)!;
    await Promise.all([session.kill(), session.kill()]);
    expect(pty.killSignals).toEqual(["SIGKILL"]);
    expect(session.status).toBe("killed");
  });
});
