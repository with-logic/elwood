/**
 * Real-PTY coverage for a CLI that exits during startup (PRD §9.1, C-LIFE-10). A real
 * node-pty child exits at once. node-pty never replays an exit to a later listener, and
 * its `kill()` signals whatever process holds the pid, so cleanup must neither signal
 * this PTY nor wait on its exit again. Only the spawned command is replaced; attempted
 * signals are recorded, never sent, and group kills go to the injected fake killer.
 */

import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { setStartupWaitMsForTests } from "../../src/runtime/startup/index.ts";
import { rejection } from "../helpers/startup-exit.ts";
import { installFakes, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-LIFE-10 a real PTY child that exits during startup is not signaled or awaited again", async () => {
  installFakes();
  // The real child must exit inside the startup window, even on a loaded host.
  setStartupWaitMsForTests(3_000);
  const signals: string[] = [];
  let leaderPid = 0;
  let exited = false;
  let listenersAfterExit = 0;
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory({ ...options, command: "/bin/sh", args: ["-c", "exit 12"] });
    leaderPid = pty.pid;
    pty.onExit(() => {
      exited = true;
    });
    return {
      ...pty,
      // A wait for this exit would subscribe after it was delivered: it never resolves.
      onExit: (handler) => {
        if (exited) listenersAfterExit += 1;
        return pty.onExit(handler);
      },
      kill: (signal) => void signals.push(signal ?? "SIGTERM"),
    };
  });
  const failure = await rejection(startClaude({ cwd: tempDir() }));
  expect(failure.code).toBe("claude_start_failed");
  expect(failure.details).toMatchObject({ exitCode: 12 });
  expect(signals).toEqual([]);
  expect(listenersAfterExit).toBe(0);
  expect(reapedGroups).toEqual([leaderPid]);
}, 20_000);
