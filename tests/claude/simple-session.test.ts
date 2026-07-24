/**
 * Integration coverage for ClaudeSession against a faked Claude session
 * (PRD §5.8, C-API-47/51): the ergonomic facade lazily starts the real session
 * machinery, exposes it, and closes it — driving the concrete `launch()` wiring.
 */

import { afterEach, describe, expect, test } from "vitest";
import { ClaudeSession } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession (C-API-47/50/51)", () => {
  test("lazily starts the real Claude session on start(), exposes it, and closes it", async () => {
    installFakes();
    const session = new ClaudeSession({ cwd: tempDir(), autotrust: true });
    expect(session.session).toBeUndefined(); // not started at construction
    expect(session.status).toBe("starting"); // pre-start status
    const live = await session.start();
    expect(session.session).toBe(live);
    expect(session.status).not.toBe("starting");
    expect(typeof live.elwoodSessionId).toBe("string");
    await session.close(); // stops the underlying session (no throw)
    expect(["stopped", "exited", "killed"]).toContain(session.session?.status);
  });

  test("constructs with NO arguments and defaults cwd to process.cwd()", async () => {
    installFakes();
    const previous = process.cwd();
    process.chdir(tempDir());
    try {
      const session = new ClaudeSession(); // zero args — the headline ergonomic case
      const live = await session.start();
      expect(live.cwd).toBe(process.cwd());
      await session.close();
    } finally {
      process.chdir(previous);
    }
  });

  test("a delegated control method (resize) lazy-starts the real session; on/off actually wire through", async () => {
    installFakes();
    const session = new ClaudeSession({ cwd: tempDir(), autotrust: true });
    const seen: string[] = [];
    const handler = (e: { status: string }) => seen.push(e.status); // buffered pre-start subscription
    session.on("status", handler);
    await session.resize({ cols: 90, rows: 30 }); // delegated method that lazy-starts (no readiness wait)
    expect(session.session).toBeDefined();
    const pty = ptys.at(-1); // the launched PTY drives the live session's status events
    expect(pty).toBeDefined();
    seen.length = 0;
    pty?.emitExit({ exitCode: 0 }); // a real status transition on the live session
    expect(seen.length).toBeGreaterThan(0); // the buffered handler was attached on start and FIRED
    const before = seen.length;
    session.off("status", handler); // typed off wrapper must DETACH the live subscription
    pty?.emitExit({ exitCode: 0 });
    expect(seen.length).toBe(before); // no further delivery after off() — genuinely detached
    await session.close();
  });

  test("login() delegates to the live session's re-authentication flow (C-API-43)", async () => {
    installFakes();
    const session = new ClaudeSession({ cwd: tempDir(), autotrust: true });
    // The fake login flow times out quickly; we only need to prove login() lazy-starts
    // and delegates. Any resolution/rejection is fine — it reached the live session.
    await session.login({ provideCode: () => "x", timeoutMs: 200 }).catch(() => undefined);
    expect(session.session).toBeDefined();
    await session.close();
  });

  test("stop()/kill()/teardown() before any start are safe no-ops", async () => {
    const session = new ClaudeSession({ cwd: tempDir() });
    await expect(session.stop()).resolves.toBeUndefined();
    await expect(session.kill()).resolves.toBeUndefined();
    await expect(session.teardown()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
    expect(session.session).toBeUndefined();
  });
});
