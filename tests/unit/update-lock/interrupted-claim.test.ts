/**
 * A claimant killed while writing its first owner record must not strand the lease
 * (PRD §9.2, C-PERF-04). The claimant is a real process running the real claim; it is
 * SIGKILLed inside the filesystem call under test, leaving whatever that call leaves.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

test("C-PERF-04 an unreadable lease untouched for a day is presumed abandoned and recovered", async () => {
  const root = tempDir("elwood-update-lock-abandoned-");
  const path = updateLockPath("codex", root);
  const lease = (ageMs: number) => {
    mkdirSync(path);
    writeFileSync(join(path, "owner"), "123");
    const touched = new Date(Date.now() - ageMs);
    utimesSync(path, touched, touched);
  };
  const attempts: string[] = [];
  const update = (name: string) =>
    coordinatedAutoupdate("codex", async () => void attempts.push(name), {
      root,
      pollMs: 5,
      staleMs: 50,
    });
  // Left by a version that wrote the record in place, or by storage that lost the write.
  lease(25 * 60 * 60 * 1_000);
  await update("after a day");
  expect(attempts).toEqual(["after a day"]);
  // Merely stale, it may belong to a live updater this version cannot read: fail safe.
  lease(23 * 60 * 60 * 1_000);
  await update("within the day");
  expect(attempts).toEqual(["after a day"]);
  // Failing safe keeps the possibly live lease and its record, wherever recovery left it.
  const kept = [path, `${path}.recovery`].find((candidate) => existsSync(candidate));
  expect(readFileSync(join(kept as string, "owner"), "utf8")).toBe("123");
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
