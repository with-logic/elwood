/** A live global updater is never retired solely for age (PRD §9.2, C-PERF-04). */
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

test("C-PERF-04 an old live-owner lease remains intact through contention", async () => {
  const root = tempDir("elwood-aged-live-owner-");
  const lease = updateLockPath("codex", root);
  const record = `${process.pid}:00000000-0000-4000-8000-00000000000a`;
  mkdirSync(lease);
  writeFileSync(join(lease, "owner"), record);
  utimesSync(lease, new Date(0), new Date(0));
  let attempts = 0;
  await expect(
    coordinatedAutoupdate("codex", () => Promise.resolve(void attempts++), {
      root,
      pollMs: 1,
      staleMs: 0,
      waitMs: 1_000,
    }),
  ).rejects.toMatchObject({ details: { updateReason: "active_owner" } });
  expect(attempts).toBe(0);
  expect(readFileSync(join(lease, "owner"), "utf8")).toBe(record);
  expect(existsSync(`${lease}.recovery`)).toBe(false);
});
