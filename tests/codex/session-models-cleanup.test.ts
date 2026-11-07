/**
 * Model-session teardown preserves shared fixtures until all stop outcomes settle,
 * including failures (PRD §5.7, C-API-24).
 */

import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { reapedGroups, tempDir } from "./helpers.ts";
import {
  cleanupModelSessions,
  sandboxCodexHome,
  trackModelSession,
} from "./session-models-helpers.ts";

afterEach(cleanupModelSessions);

test.each([
  "async",
  "sync",
] as const)("C-API-24 %s stop failure waits for peers before resetting process and home fixtures", async (failureKind) => {
  const originalHome = process.env["CODEX_HOME"];
  sandboxCodexHome(tempDir());
  const sessionHome = process.env["CODEX_HOME"];
  reapedGroups.push(123);
  const failure = new Error("stop failed");
  const peer = Promise.withResolvers<void>();
  trackModelSession({
    stop: () => {
      if (failureKind === "sync") throw failure;
      return Promise.reject(failure);
    },
  });
  let peerStarted = false;
  trackModelSession({
    stop: () => {
      peerStarted = true;
      return peer.promise;
    },
  });
  let settled = false;
  const completion = cleanupModelSessions().catch((error: unknown) => {
    settled = true;
    return error;
  });
  try {
    await setImmediate();
    expect(peerStarted).toBe(true);
    expect(settled).toBe(false);
    expect(reapedGroups).toEqual([123]);
    expect(process.env["CODEX_HOME"]).toBe(sessionHome);
  } finally {
    peer.resolve();
    await completion;
  }
  expect(await completion).toMatchObject({ errors: [failure] });
  expect(reapedGroups).toEqual([]);
  expect(process.env["CODEX_HOME"]).toBe(originalHome);
});
