/** Probe completion follows the direct child, not descendant-held stdio (PRD §9.2, C-PERF-05). */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { tempDir } from "../helpers/tmp.ts";

// The descendant inherits the probe's stdout/stderr pipes, outlives its parent, and
// keeps writing to them; a marker proves the later write succeeded.
const descendant = (root: string) => `
  const fs = require("node:fs");
  fs.writeFileSync(${JSON.stringify(join(root, "descendant"))}, String(process.pid));
  setTimeout(() => process.stdout.write("late", () =>
    fs.writeFileSync(${JSON.stringify(join(root, "wrote"))}, "ok")), 700);
  setTimeout(() => process.exit(), 20000);
`;
const leader = (root: string) => `
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  process.stdout.write("leader-out");
  process.stderr.write("leader-err");
  spawn(process.execPath, ["-e", ${JSON.stringify(descendant(root))}], {
    stdio: ["ignore", "inherit", "inherit"],
  }).unref();
  const wait = () => fs.existsSync(${JSON.stringify(join(root, "descendant"))})
    ? process.exit(0) : setTimeout(wait, 10);
  wait();
`;
const completed = { status: 0, stdout: "leader-out", stderr: "leader-err" };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killDescendant(root: string): void {
  if (!existsSync(join(root, "descendant"))) return;
  try {
    process.kill(Number(readFileSync(join(root, "descendant"), "utf8")), "SIGKILL");
  } catch {}
}

test("C-PERF-05 a probe completes on direct-child exit while a descendant holds its stdio", async () => {
  const root = tempDir("elwood-probe-stdio-");
  setProbeTimeoutMsForTests(3_000);
  try {
    // No false timeout: the leader exited zero, and everything it wrote is delivered.
    expect(await runProbe(process.execPath, ["-e", leader(root)])).toEqual(completed);
    const pid = Number(readFileSync(join(root, "descendant"), "utf8"));
    // Normal completion neither signals the descendant nor breaks the pipe it writes to.
    await expect.poll(() => existsSync(join(root, "wrote")), { timeout: 5_000 }).toBe(true);
    expect(alive(pid)).toBe(true);
  } finally {
    killDescendant(root);
  }
});

test("C-PERF-05 descendant-held probe pipes do not keep the host process alive", async () => {
  const root = tempDir("elwood-probe-stdio-host-");
  const probe = fileURLToPath(new URL("../../src/runtime/probe.ts", import.meta.url));
  const host = `
    const { runProbe } = await import(${JSON.stringify(probe)});
    console.log(JSON.stringify(await runProbe(process.execPath, ["-e", process.argv[1]])));
  `;
  try {
    // A real host: it exits by itself although the descendant lives on for 20 seconds.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", host, leader(root)],
      { timeout: 10_000 },
    );
    expect(JSON.parse(stdout)).toEqual(completed);
    expect(alive(Number(readFileSync(join(root, "descendant"), "utf8")))).toBe(true);
  } finally {
    killDescendant(root);
  }
});
