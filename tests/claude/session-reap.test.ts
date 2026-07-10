/**
 * Session-level coverage for reap-failure handling on PTY exit.
 * Covers PRD §5.3/§9.4 (C-LIFE-10): a reap failure never keeps the session live,
 * is surfaced durably rather than thrown from the native exit callback, and an
 * explicit shutdown reaps-or-rejects instead of hiding the failure.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { setGroupKillerForTests } from "../../src/runtime/reap-tree.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** A group killer that always throws EPERM — never a real system kill (injected fake). */
function throwingKiller(): void {
  setGroupKillerForTests({
    killGroup: () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
  });
}

describe("C-LIFE-10 session reap-failure handling", () => {
  test("a throwing reaper on exit still reaches 'exited' and surfaces a durable diagnostic", async () => {
    // Finding E: a reap failure on an already-exited PTY must NOT keep the session
    // live; terminal evidence is submitted first, and the failure surfaces as a
    // durable `reap_failed` warning (persisted + replayed) carrying the pgid + code
    // — not a single transient activity thrown out of the native exit callback.
    const cwd = tempDir();
    installFakes();
    throwingKiller();
    const session = await startClaude({ cwd });
    const leaderPid = ptys.at(-1)!.pid;
    ptys.at(-1)!.emitExit({ exitCode: 0 }); // unsolicited exit; reap throws
    expect(session.status).toBe("exited"); // still terminal despite the reap failure
    // Persisted into the session snapshot, content-free, with pgid + normalized code.
    expect(session.warnings).toMatchObject([
      { code: "reap_failed", source: "lifecycle", processGroupId: leaderPid, errorCode: "EPERM" },
    ]);
    // A LATE subscriber still replays it on both warning and activity (not lost).
    const replayed: string[] = [];
    const activityLabels: string[] = [];
    session.on("warning", (w) => replayed.push(w.code));
    session.on("activity", (a) => {
      if (a.kind === "warning") activityLabels.push(a.label);
    });
    expect(replayed).toEqual(["reap_failed"]);
    expect(activityLabels).toEqual(["reap_failed"]);
  });

  test("Finding B: stop() after a failed exit-reap REJECTS with a typed error (no hidden failure)", async () => {
    // The best-effort exit reap fails (unlatched). A later explicit stop() must NOT
    // swallow-and-resolve: it retries the reap and rejects with `termination_failed`
    // so the caller learns the group was not confirmed reaped (C-ERR-01).
    const cwd = tempDir();
    installFakes();
    throwingKiller();
    const session = await startClaude({ cwd });
    ptys.at(-1)!.emitExit({ exitCode: 0 }); // exit reap fails, leaves reaper unlatched
    expect(session.status).toBe("exited");
    await expect(session.stop()).rejects.toMatchObject({ code: "termination_failed" });
  });

  test("Finding C: stop() after a successful exit-reap does NOT re-signal the dead PTY", async () => {
    // A stop() racing after the first exit callback already reaped must one-shot
    // no-op (reaper latched) and resolve promptly — never re-signal the dead PTY
    // (node-pty won't replay exit; the pid may be recycled) and never re-reap.
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const pty = ptys.at(-1)!;
    pty.emitExit({ exitCode: 0 }); // exit reap succeeds and latches
    reapedGroups.length = 0;
    pty.killSignals.length = 0;
    await session.stop(); // already terminal: one-shot no-op, resolves
    expect(session.status).toBe("exited");
    expect(pty.killSignals).toEqual([]); // no re-signal of the dead PTY
    expect(reapedGroups).toEqual([]); // reaper already latched: no second kill(-pgid)
  });
});
