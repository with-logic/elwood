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

  test("SNAPSHOTS cwd at construction: a chdir before lazy launch does not move the project", async () => {
    installFakes();
    const previous = process.cwd();
    const dirA = tempDir();
    const dirB = tempDir();
    process.chdir(dirA);
    try {
      const session = new ClaudeSession(); // default cwd captured NOW = dirA
      const expectedCwd = process.cwd(); // the resolved/canonical dirA at construction time
      process.chdir(dirB); // move the process BEFORE the first use
      const live = await session.start(); // lazy launch — must still target dirA, not dirB
      expect(live.cwd).toBe(expectedCwd);
      expect(live.cwd).not.toBe(process.cwd()); // and definitely NOT the current (moved) dir
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
    // Prove login() lazy-starts AND actually drives the live re-auth flow, not just startup: the
    // real flow submits `/login` to the PTY. A no-op wrapper `login` would leave `writes` empty.
    await session.login({ provideCode: () => "x", timeoutMs: 200 }).catch(() => undefined);
    expect(session.session).toBeDefined();
    const pty = ptys.at(-1);
    expect(pty?.writes.some((w) => w.includes("/login"))).toBe(true); // the live flow ran, not a no-op
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
