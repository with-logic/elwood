/**
 * Recovering an abandoned, unreadable lease removes only that generation (PRD §9.2,
 * C-PERF-04). An unreadable record has no token, so a cleaner paused before its destructive
 * step must still not touch a successor that reached the shared recovery path meanwhile.
 */
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const race = vi.hoisted(() => ({
  recovery: "",
  armed: false,
  peerDuringDiscard: undefined as (() => Promise<void>) | undefined,
}));
const successor = `${process.pid}:22222222-2222-4222-8222-222222222222`;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Meanwhile the lease was recovered, a live successor claimed, and a third party moved
  // that successor into the recovery path the paused cleaner is about to clean.
  const successorArrives = async (): Promise<void> => {
    if (!race.armed) return;
    race.armed = false;
    await actual.rm(race.recovery, { recursive: true });
    await actual.mkdir(race.recovery);
    await actual.writeFile(join(race.recovery, "owner"), successor);
  };
  return {
    ...actual,
    // The cleaner's destructive step, whichever form it takes: deleting the record in
    // place, or taking the recovered directory for itself.
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === join(race.recovery, "owner")) await successorArrives();
      // While the cleaner holds the abandoned lease privately, neither the lease nor the
      // recovery path exists, so a peer is free to claim, update, and release.
      if (String(args[0]).startsWith(`${race.recovery}.`)) {
        const peer = race.peerDuringDiscard;
        race.peerDuringDiscard = undefined;
        await peer?.();
      }
      return actual.rm(...args);
    },
    // A readable dead lease is cleaned in place; the same gap opens once it is removed.
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      const result = await actual.rmdir(...args);
      const peer = race.peerDuringDiscard;
      if (String(args[0]) === race.recovery) {
        race.peerDuringDiscard = undefined;
        await peer?.();
      }
      return result;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[0]) === race.recovery) await successorArrives();
      return actual.rename(...args);
    },
  };
});

test("C-PERF-04 a paused cleaner of an abandoned lease cannot remove a successor generation", async () => {
  const root = tempDir("elwood-update-lock-abandoned-successor-");
  const path = updateLockPath("codex", root);
  race.recovery = `${path}.recovery`;
  mkdirSync(path);
  writeFileSync(join(path, "owner"), "unreadable");
  const abandoned = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  utimesSync(path, abandoned, abandoned);
  race.armed = true;
  let ran = false;
  await coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    { root, pollMs: 1, staleMs: 1 },
  );
  expect(race.armed).toBe(false);
  // The live successor keeps its record, and no competing update ran beside it.
  expect(ran).toBe(false);
  expect(readFileSync(join(race.recovery, "owner"), "utf8")).toBe(successor);
  expect(existsSync(path)).toBe(false);
});

test.each([
  ["an abandoned unreadable", "unreadable", 25 * 60 * 60 * 1_000],
  ["a dead owner's", "99999999:00000000-0000-4000-8000-000000000000", 1_000],
])("C-PERF-04 a waiter that recovered %s lease skips its update once a peer completed one", async (_lease, record, ageMs) => {
  const root = tempDir("elwood-update-lock-recovered-peer-");
  const path = updateLockPath("codex", root);
  race.recovery = `${path}.recovery`;
  mkdirSync(path);
  writeFileSync(join(path, "owner"), record);
  const touched = new Date(Date.now() - ageMs);
  utimesSync(path, touched, touched);
  const attempts: string[] = [];
  const update = (name: string) =>
    coordinatedAutoupdate("codex", async () => void attempts.push(name), {
      root,
      pollMs: 1,
      staleMs: 1,
    });
  // The peer claims, updates, and releases in the gap recovery leaves before the waiter's claim.
  race.peerDuringDiscard = () => update("peer");
  await update("waiter");
  expect(race.peerDuringDiscard).toBeUndefined();
  expect(attempts).toEqual(["peer"]);
});
