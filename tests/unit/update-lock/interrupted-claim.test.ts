/**
 * A claimant killed while writing its first owner record must not strand the lease
 * (PRD §9.2, C-PERF-04). The claimant is a real process running the real claim; it is
 * SIGKILLed inside the filesystem call under test, leaving whatever that call leaves.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const lockUrl = pathToFileURL(
  fileURLToPath(new URL("../../../src/runtime/update/lock.ts", import.meta.url)),
).href;

// `writeFile` dies after a partial record reaches the disk; `rename` dies before it publishes.
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
    fs.promises.rename = async () => die();
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
  "writeFile",
  "rename",
])("C-PERF-04 a claimant killed inside %s leaves a lease the next updater recovers", async (dieIn) => {
  const root = tempDir("elwood-update-lock-interrupted-");
  expect(await runClaimant(root, dieIn)).toBe("SIGKILL");
  // Whatever the dead claimant left behind, it is not a lease other updaters must judge.
  expect(readdirSync(root)).not.toEqual([]);
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
});
