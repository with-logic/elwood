/**
 * A record left half-written by a dying owner must not keep that owner's lease
 * unremovable (PRD §9.2, C-PERF-04).
 */

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const leaseOptions = (root: string) => ({ root, pollMs: 5, staleMs: 500 });

test("C-PERF-04 a pending owner record left by a dead owner does not block recovery", async () => {
  const root = tempDir("elwood-update-lock-pending-");
  const path = updateLockPath("codex", root);
  mkdirSync(path);
  writeFileSync(join(path, "owner"), "99999999:00000000-0000-4000-8000-000000000000");
  // What an owner killed mid-write leaves: a uniquely named record never committed.
  // Left in place it would keep the lease directory non-empty and unremovable.
  writeFileSync(join(path, "owner.next.11111111-2222-3333-4444-555555555555"), "partial");
  const stale = new Date(Date.now() - 1_000);
  utimesSync(path, stale, stale);
  let ran = false;
  await coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    leaseOptions(root),
  );
  expect(ran).toBe(true);
  expect(existsSync(path)).toBe(false);
});
