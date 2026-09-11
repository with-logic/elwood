/**
 * Real-process coverage for the global update lease (PRD §9.2, C-PERF-04).
 * Same-user hosts must coordinate even when their TMPDIR environments differ.
 *
 * The guarantee under test is mutual exclusion among CONCURRENT contenders, so
 * every child must be inside `coordinatedAutoupdate` before any of them may
 * finish. Each child therefore announces itself and waits at a filesystem
 * barrier first; without it, a child that the OS scheduled late (this suite runs
 * under heavy parallel-suite load) starts after the lease has already been
 * released and legitimately runs its own update — a fresh invocation, not a
 * mutual-exclusion failure — which made this test flaky rather than wrong.
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
    import { appendFile, mkdir, readdir } from "node:fs/promises";
    import { coordinatedAutoupdate } from ${JSON.stringify(lockUrl)};
    import { cachedAutoupdate, setUpdateCoordinatorForTests } from ${JSON.stringify(onceUrl)};
    // Barrier: announce arrival, then wait until every sibling has arrived, so all
    // six are genuinely concurrent when they contend for the lease.
    const ready = process.env.ELWOOD_TEST_READY;
    await mkdir(ready, { recursive: true });
    await mkdir(ready + "/" + process.pid);
    const deadline = Date.now() + 60_000;
    for (;;) {
      if ((await readdir(ready)).length >= ${barrierSize}) break;
      if (Date.now() > deadline) throw new Error("barrier timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(adapter, update, {
        root: process.env.ELWOOD_TEST_LOCK_ROOT,
        pollMs: 5,
        staleMs: 30_000,
      }),
    );
    await cachedAutoupdate("codex", async () => {
      await appendFile(process.env.ELWOOD_TEST_ATTEMPTS, process.pid + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
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
