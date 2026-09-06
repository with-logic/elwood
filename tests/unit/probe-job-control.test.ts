/** Real-PTY regression for probe shells preserving CLI head terminal ownership (C-CLI-18). */

import { fileURLToPath } from "node:url";
import { spawn } from "node-pty";
import { expect, test } from "vitest";

const fixture = fileURLToPath(new URL("../fixtures/probe-job-control.ts", import.meta.url));

test("C-CLI-18 subprocess probes preserve the caller PTY foreground group", async () => {
  const result = await runFixture();
  expect(result.output).toContain("ELWOOD_PROBE_FOREGROUND=true");
  expect(result.exitCode).toBe(0);
});

function runFixture(): Promise<{ readonly exitCode: number; readonly output: string }> {
  return new Promise((resolve, reject) => {
    const terminal = spawn(process.execPath, ["--no-warnings", fixture], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env },
    });
    let output = "";
    const timer = setTimeout(() => {
      terminal.kill("SIGKILL");
      reject(new Error("probe job-control fixture timed out"));
    }, 10_000);
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ exitCode, output });
    });
  });
}
