/**
 * Conformance tests for the short bridge socket home.
 * Covers PRD §8.1 and C-STATE-12.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { onlyLaunchArtifact } from "../helpers/launch-artifacts.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** The per-launch socket path is minted fresh and written into the bridge script,
 * NOT onto the persisted record (near-stateless). Read it back from the script. */
function socketPathFromBridge(stateDir: string, id: string): string {
  const script = readFileSync(
    onlyLaunchArtifact(join(stateDir, "sessions", id), "hook-bridge"),
    "utf8",
  );
  return /const socketPath = "([^"]+)"/.exec(script)![1]!;
}

describe("bridge socket home", () => {
  test("C-STATE-12 long stateDir sessions start, dispatch hooks, and tear down", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, "n".repeat(80), "deeply".repeat(12), "elwood-state");
    expect(stateDir.length).toBeGreaterThan(160);
    installFakes();
    const session = await startClaude({ cwd, stateDir });
    // The socket path is regenerated per launch, kept short, and never on the record.
    const socketPath = socketPathFromBridge(stateDir, session.elwoodSessionId);
    expect(socketPath.length).toBeLessThan(104);
    expect(socketPath.startsWith(tmpdir())).toBe(true);
    const record = JSON.parse(
      readFileSync(join(stateDir, "sessions", session.elwoodSessionId, "session.json"), "utf8"),
    );
    expect(record).not.toHaveProperty("paths");
    // The real bridge bound the short socket: dispatch works end to end.
    const result = await ptys[0]!.dispatchHook(
      session.elwoodSessionId,
      { hook_event_name: "SessionStart", session_id: "claude-1", cwd, source: "startup" },
      stateDir,
    );
    expect(result.exitCode).toBe(0);
    const socketHome = dirname(socketPath);
    expect(existsSync(socketHome)).toBe(true);
    await session.teardown();
    expect(existsSync(socketHome)).toBe(false);
    expect(existsSync(join(stateDir, "sessions", session.elwoodSessionId))).toBe(false);
  });
});
