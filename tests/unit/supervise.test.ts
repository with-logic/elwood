/**
 * Behavioral coverage for the developer process supervisor behind `npm run dev:web`
 * and the `example:*` scripts (PRD §11, C-APP-11): the entry runs under the same Node
 * binary, its exit status is mirrored, and its whole process tree dies with it.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

const supervisor = new URL("../../scripts/supervise.ts", import.meta.url).pathname;

function runSupervisor(args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", supervisor, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("scripts/supervise.ts", () => {
  test("C-APP-11 prints usage and exits 2 without an entry", async () => {
    const result = await runSupervisor([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: node scripts/supervise.ts <entry.ts>");
  });

  test("C-APP-11 runs the entry under the supervisor's own Node and mirrors its exit code", async () => {
    const dir = tempDir("elwood-supervise-");
    const entry = join(dir, "entry.mjs");
    const execPathFile = join(dir, "execPath.txt");
    writeFileSync(
      entry,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], process.execPath);
process.exit(3);
`,
    );
    const result = await runSupervisor([entry, execPathFile]);
    expect(result.code).toBe(3);
    expect(readFileSync(execPathFile, "utf8")).toBe(process.execPath);
  });

  test("C-APP-11 a grandchild left behind by the entry is killed when the entry exits", async () => {
    // The entry backgrounds a sleeper (as a wrapped agent might) and exits; the
    // supervisor's exit must sweep the whole tree so nothing survives `npm run`.
    const dir = tempDir("elwood-supervise-");
    const entry = join(dir, "entry.mjs");
    const pidFile = join(dir, "grandchild.pid");
    writeFileSync(
      entry,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
writeFileSync(process.argv[2], String(sleeper.pid));
setTimeout(() => process.exit(0), 100);
`,
    );
    const result = await runSupervisor([entry, pidFile]);
    expect(result.code).toBe(0);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 50 && alive(grandchild); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(alive(grandchild)).toBe(false);
  });
});
