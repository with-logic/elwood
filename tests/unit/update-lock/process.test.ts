/**
 * Real-process coverage for the global update lease (PRD §9.2, C-PERF-04).
 * Same-user hosts must coordinate even when their TMPDIR environments differ.
 *
 * The owner stays active until every contender has observed its live lease.
 * A barrier before calling the coordinator would still let a delayed child
 * arrive after the first update finishes and legitimately start another one.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { tempDir } from "../../helpers/tmp.ts";

const barrierSize = 6;

test("C-PERF-04 separate Node processes mutate the installer target exactly once", async () => {
  const root = tempDir("elwood-update-lock-process-");
  const attempts = join(root, "attempts.txt");
  const onceUrl = pathToFileURL(
    fileURLToPath(new URL("../../../src/runtime/update/once.ts", import.meta.url)),
  ).href;
  const lockUrl = pathToFileURL(
    fileURLToPath(new URL("../../../src/runtime/update/lock.ts", import.meta.url)),
  ).href;
  const ready = join(root, "ready");
  const child = `
    import fs, { appendFile, mkdir, readdir } from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { coordinatedAutoupdate } from ${JSON.stringify(lockUrl)};
    import { cachedAutoupdate, setUpdateCoordinatorForTests } from ${JSON.stringify(onceUrl)};
    const ready = process.env.ELWOOD_TEST_READY;
    await mkdir(ready, { recursive: true });
    const announce = () => mkdir(ready + "/" + process.pid, { recursive: true });
    const stat = fs.stat;
    let observed = false;
    fs.stat = async (...args) => {
      const result = await stat(...args);
      if (!observed && args[0] === process.env.ELWOOD_TEST_LOCK_ROOT + "/codex.lock") {
        observed = true;
        await announce();
      }
      return result;
    };
    syncBuiltinESMExports();
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(adapter, update, {
        root: process.env.ELWOOD_TEST_LOCK_ROOT,
        pollMs: 5,
        staleMs: 30_000,
      }),
    );
    await cachedAutoupdate("codex", async () => {
      await appendFile(process.env.ELWOOD_TEST_ATTEMPTS, process.pid + "\\n");
      await announce();
      const deadline = Date.now() + 60_000;
      while ((await readdir(ready)).length < ${barrierSize}) {
        if (Date.now() > deadline) throw new Error("lease observation barrier timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
  `;
  const exits = await Promise.all(
    Array.from({ length: barrierSize }, (_, index) =>
      runChild(child, root, attempts, ready, index),
    ),
  );
  expect(exits).toEqual(Array.from({ length: barrierSize }, () => 0));
  expect(readFileSync(attempts, "utf8").trim().split("\n")).toHaveLength(1);
});

function runChild(
  script: string,
  root: string,
  attempts: string,
  ready: string,
  index: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    const childProcess = spawn(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          ELWOOD_TEST_ATTEMPTS: attempts,
          ELWOOD_TEST_LOCK_ROOT: root,
          ELWOOD_TEST_READY: ready,
          TMPDIR: join(root, `independent-tmp-${index}`),
        },
        stdio: "ignore",
      },
    );
    childProcess.on("close", resolve);
  });
}
