/**
 * Session-level coverage for reap-failure handling on PTY exit.
 * Covers PRD §5.3/§9.4 (C-LIFE-10): a reap failure never keeps the session live,
 * is surfaced as a live terminal-status transition rather than thrown from the
 * native exit callback, and an explicit shutdown reaps-or-rejects instead of hiding
 * the failure.
 */

import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { setProcessTreeOpsForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { bridgeAccepts } from "../helpers/fake-pty.ts";
import { onlyLaunchArtifact } from "../helpers/launch-artifacts.ts";
import {
  installFakes,
  ptys,
  readBridgeScript,
  reapedGroups,
  resetFakes,
  tempDir,
} from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

/** A group killer that always throws EPERM — never a real system kill (injected fake). */
function throwingKiller(): void {
  setProcessTreeOpsForTests({
    killGroup: () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
  });
}

describe("C-LIFE-10 session reap-failure handling", () => {
  test("a throwing reaper on exit still reaches 'exited' and surfaces a live diagnostic", async () => {
    // C-LIFE-10: a reap failure on an already-exited PTY must NOT keep the session
    // live; terminal evidence is submitted first, and the failure surfaces as a live
    // `reap_failed` warning (emitted once, on both `warning` and `activity`) carrying
    // the pgid + code — not a single transient activity thrown out of the exit callback.
    const cwd = tempDir();
    installFakes();
    throwingKiller();
    const session = await startClaude({ cwd });
    const leaderPid = ptys.at(-1)!.pid;
    // Warnings are live-only (never replayed to late subscribers), so subscribe BEFORE
    // the exit fires the diagnostic.
    const warnings: { code: string }[] = [];
    const activityLabels: string[] = [];
    session.on("warning", (w) => warnings.push(w));
    session.on("activity", (a) => {
      if (a.kind === "warning") activityLabels.push(a.label);
    });
    ptys.at(-1)!.emitExit({ exitCode: 0 }); // unsolicited exit; reap throws
    expect(session.status).toBe("exited"); // still terminal despite the reap failure
    // Content-free, with pgid + normalized code, emitted once live on both channels.
    expect(warnings).toMatchObject([
      { code: "reap_failed", source: "lifecycle", processGroupId: leaderPid, errorCode: "EPERM" },
    ]);
    expect(activityLabels).toEqual(["reap_failed"]);
  });

  test("C-LIFE-10 stop() after a failed exit-reap REJECTS with a typed error (no hidden failure)", async () => {
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

  test("C-LIFE-10 a PTY that survives SIGKILL still rejects held submissions", async () => {
    installFakes();
    const session = await startClaude({ cwd: tempDir() });
    const pty = ptys.at(-1)!;
    vi.spyOn(pty, "kill").mockImplementation(() => {}); // never exits
    const held = session.sendMessage("held behind readiness");
    const rejected = expect(held).rejects.toMatchObject({ code: "session_not_running" });
    vi.useFakeTimers();
    const stopped = expect(session.stop()).rejects.toMatchObject({ code: "termination_failed" });
    await vi.advanceTimersByTimeAsync(120_000);
    await stopped;
    expect(session.status).not.toBe("stopped"); // no terminal evidence ever arrived
    await rejected;
  });

  test("C-LIFE-10 a teardown whose reap fails keeps that typed failure's errno", async () => {
    installFakes();
    throwingKiller();
    const session = await startClaude({ cwd: tempDir() });
    const rejected: unknown = await session.teardown().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejected).toMatchObject({ code: "teardown_failed" });
    const { failures } = (rejected as { details: { failures: unknown[] } }).details;
    expect(failures[0]).toMatchObject({
      code: "termination_failed",
      details: { errno: "EPERM" },
    });
  });

  test("C-ERR-01 stop() and kill() reject with termination_failed when signaling the PTY throws", async () => {
    // The group reap succeeds, so only the PTY signal failed. The public verbs must
    // still reject with the documented code, keeping the underlying cause and errno.
    for (const verb of ["stop", "kill"] as const) {
      installFakes();
      const session = await startClaude({ cwd: tempDir() });
      try {
        const pty = ptys.at(-1)!;
        vi.spyOn(pty, "kill").mockImplementation(() => {
          throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH", syscall: "kill" });
        });
        await expect(session[verb]()).rejects.toMatchObject({
          code: "termination_failed",
          details: { cause: "kill ESRCH", errno: "ESRCH", syscall: "kill" },
        });
        expect(reapedGroups).toContain(pty.pid);
      } finally {
        // Teardown removes the session's files without signaling the PTY again.
        await session.teardown();
        resetFakes();
      }
    }
  });

  test("C-LIFE-10 stop() and kill() whose PTY signal throws still stop the hook bridge", async () => {
    for (const verb of ["stop", "kill"] as const) {
      installFakes();
      const cwd = tempDir();
      const session = await startClaude({ cwd });
      try {
        const sessionDir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
        const { socketPath } = readBridgeScript(onlyLaunchArtifact(sessionDir, "hook-bridge"));
        expect(await bridgeAccepts(socketPath)).toBe(true);
        vi.spyOn(ptys.at(-1)!, "kill").mockImplementation(() => {
          throw new Error("kill failed");
        });
        await expect(session[verb]()).rejects.toMatchObject({ code: "termination_failed" });
        expect(await bridgeAccepts(socketPath)).toBe(false); // runtime cleanup still ran
      } finally {
        await session.teardown();
        resetFakes();
      }
    }
  });

  test("C-LIFE-10 an unresolved detached sweep keeps every later shutdown failing", async () => {
    // kill() could not read the process table, so a detached hook may still run under
    // PID 1. The leader is dead and its group reaped, so nothing can confirm it any
    // more: a later stop() or teardown() must keep rejecting, never report success.
    installFakes();
    setProcessTreeOpsForTests({
      killGroup: (pgid) => reapedGroups.push(pgid),
      listProcesses: () => Promise.reject(Object.assign(new Error("ps"), { code: "EAGAIN" })),
    });
    const session = await startClaude({ cwd: tempDir() });
    const unreadable = "Could not reap detached descendants: process table unreadable (EAGAIN)";
    await expect(session.kill()).rejects.toMatchObject({
      code: "termination_failed",
      details: { cause: unreadable, errno: "EAGAIN" },
    });
    expect(reapedGroups).toEqual([ptys.at(-1)!.pid]); // the leader group itself was reaped
    await expect(session.stop()).rejects.toMatchObject({
      code: "termination_failed",
      details: { cause: unreadable },
    });
    await expect(session.teardown()).rejects.toMatchObject({
      code: "teardown_failed",
      details: { causes: [unreadable] },
    });
  });

  test("C-LIFE-10 stop() after a successful exit-reap does NOT re-signal the dead PTY", async () => {
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
