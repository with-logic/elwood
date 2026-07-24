/**
 * Integration coverage for SimpleClaudeSession against a faked Claude session
 * (PRD §5.8, C-API-47/51): the ergonomic facade lazily starts the real session
 * machinery, exposes it, and closes it — driving the concrete `launch()` wiring.
 */

import { afterEach, describe, expect, test } from "vitest";
import { SimpleClaudeSession } from "../../src/index.ts";
import { installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("SimpleClaudeSession (C-API-47/51)", () => {
  test("lazily starts the real Claude session on start(), exposes it, and closes it", async () => {
    installFakes();
    const simple = new SimpleClaudeSession({ cwd: tempDir(), autotrust: true });
    expect(simple.session).toBeUndefined(); // not started at construction
    const session = await simple.start();
    expect(simple.session).toBe(session);
    expect(session.status).not.toBe("torn_down");
    expect(typeof session.elwoodSessionId).toBe("string");
    await simple.close(); // stops the underlying session (no throw)
    expect(["stopped", "exited", "killed"]).toContain(simple.session?.status);
  });

  test("constructs with NO arguments and defaults cwd to process.cwd()", async () => {
    installFakes();
    const previous = process.cwd();
    process.chdir(tempDir());
    try {
      const simple = new SimpleClaudeSession(); // zero args — the headline ergonomic case
      const session = await simple.start();
      expect(session.cwd).toBe(process.cwd());
      await simple.close();
    } finally {
      process.chdir(previous);
    }
  });
});
