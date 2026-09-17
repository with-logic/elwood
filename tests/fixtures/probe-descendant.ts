/** Real probe descendants that outlive their group leader (PRD §9.2, C-PERF-03). */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
// This fixture writes wherever argv points, so it only accepts a temp directory.
const root = resolve(process.argv[3]!);
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
  spawn(process.execPath, ["--no-warnings", file, "descendant", root], {
    stdio: "ignore",
  }).unref();
  const deadline = Date.now() + 10_000;
  while (!existsSync(descendantFile) && Date.now() < deadline) await delay(10);
  if (!existsSync(descendantFile)) throw new Error("descendant did not start");
  await delay(20_000);
}
