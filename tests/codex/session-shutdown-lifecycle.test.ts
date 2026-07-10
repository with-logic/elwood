/**
 * Overlapping-shutdown and guarded-startup coverage for Codex sessions.
 * Covers PRD §5.3/§9.4 (C-LIFE-10): overlapping stop/kill/teardown signal the PTY
 * at most once, and a failure in the guarded startup region tears down live
 * resources rather than leaking them. All kills go through injected fakes.
 */

import { afterEach, describe, expect, test } from "vitest";
import { setCodexHookBridgeFactoryForTests } from "../../src/codex/session.ts";
import { startCodex } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { FakePty, installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession overlapping shutdown", () => {
  test("C-LIFE-10 concurrent stop + stop signals the PTY once and settles stopped", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const pty = ptys.at(-1)!;
    reapedGroups.length = 0;
    await Promise.all([session.stop(), session.stop()]);
    expect(pty.killSignals).toEqual(["SIGTERM"]); // signaled at most once
    expect(session.status).toBe("stopped");
    expect(reapedGroups.filter((pid) => pid === pty.pid)).toEqual([pty.pid]);
  });

  test("C-LIFE-10 stop then kill signals the PTY once; the escalation does not re-signal", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const pty = ptys.at(-1)!;
    await Promise.all([session.stop(), session.kill()]);
    expect(pty.killSignals).toEqual(["SIGTERM"]);
    expect(session.status).toBe("stopped");
  });

  test("C-LIFE-10 concurrent kill + kill signals the PTY once and settles killed", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const pty = ptys.at(-1)!;
    await Promise.all([session.kill(), session.kill()]);
    expect(pty.killSignals).toEqual(["SIGKILL"]);
    expect(session.status).toBe("killed");
  });
});

describe("CodexSession guarded startup region", () => {
  test("C-LIFE-10 a failure in the guarded startup region tears down the live bridge + PTY", async () => {
    // The region spans readiness wiring/replay, exit registration, the startup
    // assertion, and startup evidence — all AFTER the bridge/PTY/terminal are live. A
    // failure in ANY of them (here, the auth-banner assertion) must run cleanup so the
    // now-live bridge is stopped and the PTY killed, never leaked.
    installFakes();
    let bridgeStopped = false;
    setCodexHookBridgeFactoryForTests(() => ({
      start: () => Promise.resolve(),
      stop: () => {
        bridgeStopped = true;
        return Promise.resolve();
      },
    }));
    setPtyFactoryForTests((options) => {
      const pty = new FakePty(options);
      ptys.push(pty);
      // Emit the auth banner only once the terminal data handler is attached (codex
      // spawns its PTY behind an await), so the banner lands in the startup output.
      const timer = setInterval(() => {
        if (pty.dataHandlers.length === 0) return;
        clearInterval(timer);
        pty.emitData("not authenticated");
      }, 0);
      return pty;
    });
    await expect(startCodex({ cwd: tempDir() })).rejects.toMatchObject({
      code: "codex_not_authenticated",
    });
    expect(bridgeStopped).toBe(true); // the live bridge was stopped by region cleanup
    expect(ptys.at(-1)!.killSignals).toContain("SIGTERM"); // the live PTY was signaled
  });
});
