/** Real probe descendants that outlive their group leader (PRD §9.2, C-PERF-03). */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
// The root arrives through the inherited environment rather than argv, so the gated probe
// below only ever receives constant arguments. This fixture writes wherever the root
// points, so it accepts a temp directory and nothing else, and every path it uses is
// derived here beside that guard.
const root = resolve(process.env["ELWOOD_PROBE_FIXTURE_ROOT"] ?? "");
if (!root.startsWith(`${resolve(tmpdir())}${sep}`))
  throw new Error("fixture root must be temporary");
const file = fileURLToPath(import.meta.url);
const descendantFile = join(root, "descendant");
if (mode === "descendant") {
  writeFileSync(descendantFile, String(process.pid));
  // Even a failed test cannot leave the fixture alive indefinitely.
  setTimeout(() => process.exit(), 20_000);
} else if (mode === "linger") {
  writeFileSync(join(root, "leader"), String(process.pid));
  spawn(process.execPath, ["--no-warnings", file, "descendant"], {
    stdio: "ignore",
  }).unref();
  const deadline = Date.now() + 10_000;
  while (!existsSync(descendantFile) && Date.now() < deadline) await delay(10);
  if (!existsSync(descendantFile)) throw new Error("descendant did not start");
  await delay(20_000);
}
