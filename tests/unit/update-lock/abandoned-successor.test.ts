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

const race = vi.hoisted(() => ({ recovery: "", armed: false }));
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
      return actual.rm(...args);
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
