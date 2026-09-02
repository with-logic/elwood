/**
 * Real-process coverage for the global update lease (PRD §9.2, C-PERF-04).
 * Same-user hosts must coordinate even when their TMPDIR environments differ.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test("C-PERF-04 separate Node processes mutate the installer target exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-process-"));
  const attempts = join(root, "attempts.txt");
  const onceUrl = pathToFileURL(
    fileURLToPath(new URL("../../../src/runtime/update-once.ts", import.meta.url)),
  ).href;
  const lockUrl = pathToFileURL(
    fileURLToPath(new URL("../../../src/runtime/update-lock.ts", import.meta.url)),
  ).href;
  const child = `
    import { appendFile } from "node:fs/promises";
    import { coordinatedAutoupdate } from ${JSON.stringify(lockUrl)};
    import { cachedAutoupdate, setUpdateCoordinatorForTests } from ${JSON.stringify(onceUrl)};
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(adapter, update, {
        root: process.env.ELWOOD_TEST_LOCK_ROOT,
        pollMs: 5,
        staleMs: 500,
      }),
    );
    await cachedAutoupdate("codex", async () => {
      await appendFile(process.env.ELWOOD_TEST_ATTEMPTS, process.pid + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  `;
  const exits = await Promise.all(
    Array.from({ length: 6 }, (_, index) => runChild(child, root, attempts, index)),
  );
  expect(exits).toEqual(Array.from({ length: 6 }, () => 0));
  expect(readFileSync(attempts, "utf8").trim().split("\n")).toHaveLength(1);
});

function runChild(
  script: string,
  root: string,
  attempts: string,
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
          TMPDIR: join(root, `independent-tmp-${index}`),
        },
        stdio: "ignore",
      },
    );
    childProcess.on("close", resolve);
  });
}
