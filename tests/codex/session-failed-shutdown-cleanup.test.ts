/**
 * A Codex `stop()` or `kill()` whose PTY signal throws still cleans up the session's
 * runtime (PRD §9.4, C-LIFE-10): the call rejects with `termination_failed`, and the
 * hook bridge no longer accepts connections. Injected fakes only.
 */

import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { bridgeAccepts } from "../helpers/fake-pty.ts";
import { launchArtifactPaths } from "../helpers/launch-artifacts.ts";
import { installFakes, ptys, readBridgeScript, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  "stop",
  "kill",
] as const)("C-LIFE-10 a Codex %s() whose PTY signal throws still stops the hook bridge", async (verb) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const pty = ptys.at(-1)!;
  try {
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    const { socketPath } = readBridgeScript(launchArtifactPaths(pty.options, dir).bridge);
    expect(await bridgeAccepts(socketPath)).toBe(true);
    vi.spyOn(pty, "kill").mockImplementation(() => {
      throw new Error("kill failed");
    });
    await expect(session[verb]()).rejects.toMatchObject({ code: "termination_failed" });
    expect(await bridgeAccepts(socketPath)).toBe(false); // runtime cleanup still ran
  } finally {
    if (verb === "stop") {
      // A throwing TERM never confirmed exit; teardown cleans resources and retains failure.
      pty.emitExit({ exitCode: 0 });
      await expect(session.teardown()).rejects.toMatchObject({
        code: "teardown_failed",
        details: {
          failures: expect.arrayContaining([
            expect.objectContaining({
              code: "termination_failed",
              details: expect.objectContaining({
                processGroupId: pty.pid,
                cause: expect.stringContaining("the leader's exit was not confirmed"),
              }),
            }),
          ]),
        },
      });
    } else await session.teardown();
  }
});
