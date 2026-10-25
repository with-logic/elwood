/**
 * Real-PTY coverage for a CLI that exits during startup (PRD §9.1, C-LIFE-10). A real
 * node-pty child exits at once. node-pty never replays an exit to a later listener, and
 * its `kill()` signals whatever process holds the pid, so cleanup must neither signal
 * nor wait on this PTY again. Only the CLI command is replaced; group kills go to the
 * injected fake killer, so no real group is signaled.
 */

import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { setStartupWaitMsForTests } from "../../src/runtime/startup/index.ts";
import { rejection } from "../helpers/startup-exit.ts";
import { installFakes, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-LIFE-10 a real CLI that exits during startup is not signaled or awaited again", async () => {
  installFakes();
  // The real child must exit inside the startup window, even on a loaded host.
  setStartupWaitMsForTests(3_000);
  const signals: string[] = [];
  let leaderPid = 0;
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory({ ...options, command: "/bin/sh", args: ["-c", "exit 12"] });
    leaderPid = pty.pid;
    return {
      ...pty,
      kill: (signal) => {
        signals.push(signal ?? "SIGTERM");
        pty.kill(signal);
      },
    };
  });
  const failure = await rejection(startClaude({ cwd: tempDir() }));
  expect(failure.code).toBe("claude_start_failed");
  expect(failure.details).toMatchObject({ exitCode: 12 });
  expect(signals).toEqual([]);
  expect(reapedGroups).toEqual([leaderPid]);
}, 20_000);
