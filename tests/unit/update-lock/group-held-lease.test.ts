/**
 * A persisted owner record naming process groups is honoured by real lease recovery, not
 * just by the parser (PRD §9.2, C-PERF-04). The records here are written directly so
 * recovery can be driven against states a live handoff reaches only by timing — an already
 * dead group, a long-stale mtime — independently of the production path that now writes
 * them (`retainLease`), which is covered by its own tests.
 */

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { serializeOwner } from "../../../src/runtime/update/owner.ts";
import { tempDir } from "../../helpers/tmp.ts";
import { spawnUpdateProcessGroup } from "../../helpers/update-process-group.ts";

/** A stale lease whose record names a dead parent but the given live groups. */
function writeGroupHeldLease(root: string, processGroupIds: readonly number[]): string {
  const path = updateLockPath("codex", root);
  mkdirSync(path, { recursive: true });
  const record = { pid: 99_999_999, token: "11111111-2222-3333-4444-555555555555" };
  writeFileSync(
    join(path, "owner"),
    serializeOwner({ ...record, ownedProcessGroupIds: [...processGroupIds] }),
  );
  const stale = new Date(Date.now() - 10_000);
  utimesSync(path, stale, stale);
  return path;
}

test("C-PERF-04 a stale lease is held by its live group alone, whatever its age", async () => {
  const group = await spawnUpdateProcessGroup();
  const root = tempDir("elwood-group-held-");
  try {
    const path = writeGroupHeldLease(root, [group.id]);
    let ran = false;
    // The recorded parent is long dead and the lease is far past its stale bound, so only
    // the surviving group can be keeping it. A contender must treat the lease as active
    // and give up rather than recover it and update — and say which kind of active it is:
    // a surviving group may outlive any bound, so waiting out the deadline is pointless.
    const update = () => {
      ran = true;
      return Promise.resolve();
    };
    await expect(
      coordinatedAutoupdate("codex", update, { root, pollMs: 2, staleMs: 5 }),
    ).rejects.toMatchObject({ details: { updateReason: "cleanup_pending" } });
    expect(ran).toBe(false);
    expect(existsSync(path)).toBe(true);
    // Once the group exits, the same lease is recoverable and the update runs, which
    // proves it was the group alone that held it and not its age or its dead parent.
    await group.killGroup();
    await coordinatedAutoupdate("codex", update, { root, pollMs: 2, staleMs: 5 });
    expect(ran).toBe(true);
  } finally {
    await group.killGroup();
  }
});
