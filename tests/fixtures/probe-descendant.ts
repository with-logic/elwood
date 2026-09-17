/** Real updater descendants and cross-process contenders (PRD §9.2, C-PERF-03/04). */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ElwoodError, elwoodError, probeFailureDetails } from "../../src/core/errors.ts";
import { runProbe } from "../../src/runtime/probe.ts";
import { coordinatedAutoupdate } from "../../src/runtime/update/lock.ts";

const mode = process.argv[2];
const root = process.argv[3]!;
const file = fileURLToPath(import.meta.url);
const descendantFile = join(root, "descendant");
if (mode === "descendant") {
  writeFileSync(descendantFile, String(process.pid));
  // Even a failed test cannot leave the fixture alive indefinitely.
  setTimeout(() => process.exit(), 20_000);
} else if (mode === "leader" || mode === "linger") {
  writeFileSync(join(root, "leader"), String(process.pid));
  spawn(process.execPath, ["--no-warnings", file, "descendant", root], {
    stdio: "ignore",
  }).unref();
  const deadline = Date.now() + 10_000;
  while (!existsSync(descendantFile) && Date.now() < deadline) await delay(10);
  if (!existsSync(descendantFile)) throw new Error("descendant did not start");
  if (mode === "linger") await delay(20_000);
} else {
  try {
    await coordinatedAutoupdate(
      "codex",
      async () => {
        if (mode === "contender") {
          writeFileSync(join(root, "mutated"), "once");
          return;
        }
        const result = await runProbe(process.execPath, ["--no-warnings", file, "leader", root]);
        if (result.status !== 0)
          throw elwoodError("codex_update_failed", "probe failed", probeFailureDetails(result));
      },
      { root, pollMs: 5, staleMs: 0, waitMs: 200 },
    );
    console.log(JSON.stringify({ result: "updated" }));
  } catch (error) {
    if (!(error instanceof ElwoodError)) throw error;
    console.log(JSON.stringify({ result: "skipped", code: error.code, details: error.details }));
  }
}
