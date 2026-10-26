/**
 * Removing a Codex home stops what still runs from it first (PRD §12, C-E2E-03). Codex 0.164
 * can start an app-server daemon for its `CODEX_HOME` that outlives the TUI and keeps writing
 * into the home (docs/cli-behavior.md, "Codex 0.164 starts an app-server daemon per
 * `CODEX_HOME`"). Its start is not predictable from a TUI launch, so these tests start it with
 * `codex app-server daemon start`, which starts the same daemon and updater every time.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loginShellCommand, userShell } from "../../src/runtime/shell.ts";
import { codexLaunches, endCodexTest } from "./codex-test-end.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
} from "./helpers.ts";
import { processesUnder, type ScratchProcess, stopProcessesUnder } from "./scratch-processes.ts";

/** Whether `rows` are still running: the same pid with the same command line. */
function anyRunning(rows: readonly ScratchProcess[]): readonly string[] {
  const listing = spawnSync("/bin/ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).stdout;
  const live = new Set(listing.split("\n").map((line) => line.trim()));
  return rows.map((row) => `${row.pid} ${row.command}`).filter((row) => live.has(row));
}

function endAll(rows: readonly ScratchProcess[]): void {
  for (const { pid } of rows) spawnSync("/bin/kill", ["-KILL", String(pid)]);
}

/** Starts the app-server daemon and its updater for `home`; returns what runs from the home. */
function startDaemon(home: string, cwd: string) {
  const started = spawnSync(userShell(), loginShellCommand("exec codex app-server daemon start"), {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { output: `${started.stdout}\n${started.stderr}`, running: processesUnder(home) };
}

/** The daemon's two processes, `codex app-server --listen ...` and its updater loop. */
const daemonOf = (rows: readonly ScratchProcess[]) =>
  rows.filter((row) => row.command.includes(" app-server "));

test("C-E2E-03 removing a Codex sandbox stops the app-server daemon Codex started for it", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  let daemon: readonly ScratchProcess[] = [];
  try {
    const { output, running } = startDaemon(sandbox.home, project.cwd);
    daemon = daemonOf(running);
    assert.match(output, /"status":"started"/);
    assert.equal(daemon.length, 2, "the daemon and its updater loop run from the sandbox");
    await endCodexTest({ sessions: [], sandbox, launches: codexLaunches(), failure: undefined });
    assert.deepEqual(anyRunning(daemon), [], "the daemon outlived its sandbox");
    assert.equal(existsSync(sandbox.home), false, "the sandbox is gone");
  } finally {
    endAll(daemon);
  }
});

test("C-E2E-03 the suite's default Codex home stops its app-server daemon when the run exits", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
}, () => {
  const script = `
    import { spawnSync } from "node:child_process";
    import { processesUnder } from "./tests/e2e/scratch-processes.ts";
    import { loginShellCommand, userShell } from "./src/runtime/shell.ts";
    const home = process.env.CODEX_HOME;
    spawnSync(userShell(), loginShellCommand("exec codex app-server daemon start"), { stdio: "ignore" });
    console.log(JSON.stringify({ home, daemon: processesUnder(home) }));
  `;
  const run = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "./tests/e2e/codex-home.ts", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const { home, daemon } = JSON.parse(run.stdout) as {
    home: string;
    daemon: readonly ScratchProcess[];
  };
  try {
    assert.equal(daemonOf(daemon).length, 2, "the daemon and its updater loop ran from the home");
    assert.deepEqual(anyRunning(daemon), [], "the daemon outlived the run's Codex home");
    assert.equal(existsSync(home), false, "the run's Codex home is gone");
  } finally {
    endAll(daemon);
  }
});

test("C-E2E-03 stopping reaches a descendant that ignores SIGTERM after its parent exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elwood_e2e_scratch_processes-"));
  let found: readonly ScratchProcess[] = [];
  try {
    // The parent exits on SIGTERM; its detached child, whose command line names nothing in
    // `dir`, ignores SIGTERM and is reparented to PID 1 once the parent is gone.
    writeFileSync(
      join(dir, "parent.mjs"),
      `import { spawn } from "node:child_process";
       const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
       console.log(child.pid);
       setInterval(() => {}, 1000);`,
    );
    const parent = spawn(process.execPath, [join(dir, "parent.mjs")], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [line] = (await once(parent.stdout, "data")) as [Buffer];
    const childPid = Number(line.toString().trim());
    found = processesUnder(dir);
    assert.deepEqual(found.map((row) => row.pid).sort(), [parent.pid, childPid].sort());
    const started = Date.now();
    stopProcessesUnder(dir);
    assert.ok(Date.now() - started >= 3_000, "the child needed SIGKILL after the grace period");
    assert.deepEqual(anyRunning(found), [], "a process from the directory is still running");
  } finally {
    endAll(found);
    rmSync(dir, { recursive: true, force: true });
  }
});
