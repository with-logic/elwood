/**
 * Integration coverage for CodexSession against a faked Codex session
 * (PRD §5.8, C-API-47/51): the ergonomic facade lazily starts the real session
 * machinery, exposes it, and closes it — driving the concrete `launch()` wiring.
 */

import { afterEach, describe, expect, test } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { installFakes, resetFakes, tempDir } from "./helpers.ts";

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

  test("typed on()/off() wire through the buffered subscription path", async () => {
    installFakes();
    const session = new CodexSession({ cwd: tempDir(), autotrust: true });
    const handler = () => {};
    session.on("status", handler); // buffered pre-start (typed wrapper)
    session.off("status", handler); // typed off wrapper removes it
    await session.start();
    session.on("activity", () => {}); // live-path on() after start
    await session.close();
  });
});
