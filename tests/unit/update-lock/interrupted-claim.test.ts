/**
 * A claimant killed while writing its first owner record must not strand the lease
 * (PRD §9.2, C-PERF-04). The claimant is a real process running the real claim; it is
 * SIGKILLed inside the filesystem call under test, leaving whatever that call leaves.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const lockUrl = pathToFileURL(
  fileURLToPath(new URL("../../../src/runtime/update/lock.ts", import.meta.url)),
).href;

// `writeFile` dies after a partial record reaches the disk, `rename` dies before it
// publishes, and `published` dies right after the real rename put the lease in place.
const claimant = `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  const die = () => process.kill(process.pid, "SIGKILL");
  const { writeFile } = fs.promises;
  if (process.env.ELWOOD_TEST_DIE_IN === "writeFile") {
    fs.promises.writeFile = async (file, data, options) => {
      await writeFile(file, String(data).slice(0, 3), options);
      die();
    };
  } else {
    const { rename } = fs.promises;
    const published = process.env.ELWOOD_TEST_DIE_IN === "published";
    fs.promises.rename = async (from, to) => {
      if (published) await rename(from, to);
      die();
    };
  }
  syncBuiltinESMExports();
  const { coordinatedAutoupdate } = await import(${JSON.stringify(lockUrl)});
  await coordinatedAutoupdate("codex", async () => {}, { root: process.env.ELWOOD_TEST_LOCK_ROOT });
`;

function runClaimant(root: string, dieIn: string): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", claimant], {
      env: { ...process.env, ELWOOD_TEST_LOCK_ROOT: root, ELWOOD_TEST_DIE_IN: dieIn },
      stdio: "ignore",
    }).on("close", (_code, signal) => resolve(signal));
  });
}

test.each([
  ["writeFile", "staging"],
  ["rename", "staging"],
  ["published", "lease"],
] as const)("C-PERF-04 a claimant killed at %s leaves only a %s, which the next updater recovers", async (dieIn, left) => {
  const root = tempDir("elwood-update-lock-interrupted-");
  expect(await runClaimant(root, dieIn)).toBe("SIGKILL");
  // Before publication only staging exists; after it, a complete lease naming a dead owner.
  const lease = updateLockPath("codex", root);
  expect(existsSync(lease)).toBe(left === "lease");
  expect(readdirSync(root).some((entry) => entry.includes(".claim."))).toBe(left === "staging");
  if (left === "lease")
    expect(readFileSync(join(lease, "owner"), "utf8")).toMatch(/^\d+:[0-9a-f-]{36}$/);
  let ran = false;
  await coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    { root, pollMs: 5, staleMs: 50 },
  );
  expect(ran).toBe(true);
  expect(readdirSync(root)).toEqual(["codex.completed"]);
});

test("C-PERF-04 each lease holder sweeps a bounded number of leftover staging directories", async () => {
  const root = tempDir("elwood-update-lock-sweep-");
  for (let index = 0; index < 10; index += 1) mkdirSync(join(root, `codex.lock.claim.${index}`));
  const leftovers = () => readdirSync(root).filter((entry) => entry.includes(".claim.")).length;
  const update = () => coordinatedAutoupdate("codex", () => Promise.resolve(), { root });
  await update();
  expect(leftovers()).toBe(2);
  await update();
  expect(leftovers()).toBe(0);
});

test("C-PERF-04 the sweep reads a bounded number of entries and leaves the other adapter's leftovers", async () => {
  const root = tempDir("elwood-update-lock-sweep-bound-");
  // `readdir` returns these in creation order here, so the codex leftover sits past the
  // read bound: an unbounded scan would walk every claude entry and reach it, a bounded
  // one stops first. The other adapter's leftovers are never this holder's to remove.
  for (let index = 0; index < 70; index += 1) mkdirSync(join(root, `claude.lock.claim.${index}`));
  const beyondBound = "codex.lock.claim.beyond-the-read-bound";
  mkdirSync(join(root, beyondBound));
  await coordinatedAutoupdate("codex", () => Promise.resolve(), { root });
  const entries = readdirSync(root);
  expect(entries.filter((entry) => entry.startsWith("claude.lock.claim."))).toHaveLength(70);
  expect(entries).toContain(beyondBound);
});

test("C-PERF-04 a fresh ownerless lease is a wait condition, neither claimed over nor removed early", async () => {
  const root = tempDir("elwood-update-lock-fresh-ownerless-");
  const lease = updateLockPath("codex", root);
  // What an older version's claimant leaves between creating its lease and writing its record.
  mkdirSync(lease);
  let ran = false;
  const contender = coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    { root, pollMs: 5, staleMs: 400 },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(ran).toBe(false);
  expect(readdirSync(lease)).toEqual([]);
  await contender;
  expect(ran).toBe(true);
});
