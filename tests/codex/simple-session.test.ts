/**
 * Integration coverage for CodexSession against a faked Codex session
 * (PRD §5.8, C-API-47/51): the ergonomic facade lazily starts the real session
 * machinery, exposes it, and closes it — driving the concrete `launch()` wiring.
 */

import { afterEach, describe, expect, test } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession (C-API-47/51)", () => {
  test("lazily starts the real Codex session on start(), exposes it, and closes it", async () => {
    installFakes();
    const simple = new CodexSession({ cwd: tempDir(), autotrust: true });
    expect(simple.session).toBeUndefined();
    const session = await simple.start();
    expect(simple.session).toBe(session);
    expect(typeof session.elwoodSessionId).toBe("string");
    await simple.close();
    expect(["stopped", "exited", "killed"]).toContain(simple.session?.status);
  });

  test("constructs with NO arguments and defaults cwd to process.cwd()", async () => {
    installFakes();
    const previous = process.cwd();
    process.chdir(tempDir());
    try {
      const simple = new CodexSession(); // zero args — the headline ergonomic case
      const session = await simple.start();
      expect(session.cwd).toBe(process.cwd());
      await simple.close();
    } finally {
      process.chdir(previous);
    }
  });

  test("SNAPSHOTS cwd at construction: a chdir before lazy launch does not move the project", async () => {
    installFakes();
    const previous = process.cwd();
    process.chdir(tempDir());
    try {
      const simple = new CodexSession(); // default cwd captured NOW
      const expectedCwd = process.cwd();
      process.chdir(tempDir()); // move the process BEFORE first use
      const session = await simple.start();
      expect(session.cwd).toBe(expectedCwd); // still the construction-time dir
      expect(session.cwd).not.toBe(process.cwd());
      await simple.close();
    } finally {
      process.chdir(previous);
    }
  });

  test("typed on()/off() actually deliver and detach through the live session", async () => {
    installFakes();
    const session = new CodexSession({ cwd: tempDir(), autotrust: true });
    const seen: string[] = [];
    const handler = (e: { status: string }) => seen.push(e.status); // buffered pre-start
    session.on("status", handler);
    await session.start();
    const pty = ptys.at(-1);
    expect(pty).toBeDefined();
    seen.length = 0;
    pty?.emitExit({ exitCode: 0 }); // a real status transition on the live session
    expect(seen.length).toBeGreaterThan(0); // the buffered handler attached on start and FIRED
    const before = seen.length;
    session.off("status", handler); // typed off must DETACH the live subscription
    pty?.emitExit({ exitCode: 0 });
    expect(seen.length).toBe(before); // no further delivery after off()
    await session.close();
  });
});
