/**
 * A synchronously throwing update still releases the cross-process lease (PRD §9.2,
 * C-PERF-04). The lease is retained only for a surviving process group; an updater that
 * never ran must leave nothing behind for the next host to wait out.
 */

import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

test("C-PERF-04 an update that throws synchronously releases the lease", async () => {
  const root = tempDir("elwood-sync-throw-");
  const failure = new Error("updater threw before returning a promise");
  // Throws on the call itself rather than rejecting, which is what distinguishes this from
  // the ordinary failure path: a rejection handler attached after the call never sees it.
  await expect(
    coordinatedAutoupdate(
      "claude",
      () => {
        throw failure;
      },
      { root },
    ),
  ).rejects.toBe(failure);
  // The lease must not outlive an updater that never started; otherwise every later update
  // on this host waits out a 30s stale bound for work that never happened.
  expect(existsSync(updateLockPath("claude", root))).toBe(false);
});
