/**
 * Conformance tests for the short bridge socket home.
 * Covers PRD §8.1 and C-STATE-12.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("bridge socket home", () => {
  test("C-STATE-12 long stateDir sessions start, dispatch hooks, and tear down", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, "n".repeat(80), "deeply".repeat(12), "elwood-state");
    expect(stateDir.length).toBeGreaterThan(160);
    installFakes();
    const session = await startClaude({ cwd, stateDir });
    const record = JSON.parse(
      readFileSync(join(stateDir, "sessions", session.elwoodSessionId, "session.json"), "utf8"),
    ) as { paths: { socketPath: string } };
    expect(record.paths.socketPath.length).toBeLessThan(104);
    expect(record.paths.socketPath.startsWith(tmpdir())).toBe(true);
    // The real bridge bound the short socket: dispatch works end to end.
    const result = await ptys[0]!.dispatchHook(
      session.elwoodSessionId,
      { hook_event_name: "SessionStart", session_id: "claude-1", cwd, source: "startup" },
      stateDir,
    );
    expect(result.exitCode).toBe(0);
    const socketHome = dirname(record.paths.socketPath);
    expect(existsSync(socketHome)).toBe(true);
    await session.teardown();
    expect(existsSync(socketHome)).toBe(false);
    expect(existsSync(join(stateDir, "sessions", session.elwoodSessionId))).toBe(false);
  });
});
