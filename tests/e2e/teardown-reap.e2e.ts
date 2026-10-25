/**
 * Real-CLI verification that teardown() reaps the agent process group with no
 * orphaned survivors (PRD §9.4, C-LIFE-10). This exercises the failure-safe,
 * retryable process-group cleanup: after teardown the CLI child that the PTY
 * spawned under this test process must be gone. Claude starts every hook command
 * and Codex start every hook command with `setsid()`, so the hook tests also prove
 * that a hook still running when Elwood kills the CLI — in its own session and group —
 * is reaped: on Claude's `teardown()`, on a Claude `stop()` whose SessionEnd hook
 * outlasts the graceful window, and on Codex's `teardown()`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { childPids } from "../../dev/child-lookup.ts";
import {
  type ClaudeSessionApi,
  type CodexSessionApi,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

/** True once `pid` no longer exists (signal 0 probe throws ESRCH for a dead pid). */
function isReaped(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

test("C-LIFE-10 teardown reaps the real Claude process group (no orphan)", {
  skip: skipIf(skipReason("claude")),
  timeout: 180_000,
}, async () => {
  const project = makeProject("claude");
  const before = new Set(childPids(process.pid));
  let starts = 0;
  const session: ClaudeSessionApi = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
    hooks: {
      SessionStart: () => {
        starts += 1;
      },
    },
  });
  // A failure in ANY assertion below must not leak the real process group into later
  // tests: the shared cleanup (teardown → kill fallback) always runs in `finally`.
  try {
    await waitFor(() => (starts > 0 ? true : undefined), "start SessionStart");
    // The CLI the PTY just spawned is a NEW direct child of this test process.
    const spawned = childPids(process.pid).filter((pid) => !before.has(pid));
    assert.ok(spawned.length >= 1, "the agent CLI is a live child of the test process");
    await session.teardown();
    // Every spawned leader (and thus its group) must be reaped; poll briefly for the
    // OS to finish tearing down the process group after teardown resolves.
    for (const pid of spawned) {
      await waitFor(() => (isReaped(pid) ? true : undefined), `pid ${pid} reaped`, 20_000);
      assert.ok(isReaped(pid), `agent pid ${pid} was reaped by teardown`);
    }
    // Teardown is idempotent and must not reject on a second call after exit.
    await session.teardown();
  } finally {
    await cleanup(session);
  }
});

/** A hook command that records its pid and then sleeps, in the CLI's own shell. */
const holdCommand = (pidFile: string) => `echo $$ > '${pidFile}'; exec sleep 120`;

/** The same hook as a Claude project-settings entry. */
function slowHook(pidFile: string): unknown {
  return [{ hooks: [{ type: "command", command: holdCommand(pidFile), timeout: 600 }] }];
}

function readHookPid(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/**
 * The precondition the leader-group SIGKILL alone cannot handle: the hook runs in
 * its own process group, tied to the CLI leader only by parent pids.
 */
async function hookShape(hookPid: number, leaders: readonly number[]) {
  const table = await listProcessTable(10_000);
  const parent = (pid: number) => table.find((entry) => entry.pid === pid)?.ppid ?? 1;
  let ancestor = parent(hookPid);
  while (ancestor > 1 && !leaders.includes(ancestor)) ancestor = parent(ancestor);
  const row = table.find((entry) => entry.pid === hookPid);
  return { ownGroup: row?.pgid === hookPid, descendsFromLeader: ancestor > 1 };
}
const detached = { ownGroup: true, descendsFromLeader: true };

/** Starts Claude in a project whose own settings add one slow hook for `event`. */
async function startWithSlowHook(event: "SessionStart" | "SessionEnd") {
  const project = makeProject("claude");
  const pidFile = join(project.cwd, "hook.pid");
  mkdirSync(join(project.cwd, ".claude"), { recursive: true });
  const settings = { hooks: { [event]: slowHook(pidFile) } };
  writeFileSync(join(project.cwd, ".claude", "settings.json"), JSON.stringify(settings));
  const before = new Set(childPids(process.pid));
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
  });
  const leaders = childPids(process.pid).filter((pid) => !before.has(pid));
  return { session, leaders, pidFile };
}

test("C-LIFE-10 teardown reaps a Claude hook running in its own process group", {
  skip: skipIf(skipReason("claude")),
  timeout: 180_000,
}, async () => {
  const { session, leaders, pidFile } = await startWithSlowHook("SessionStart");
  let hookPid: number | undefined;
  try {
    hookPid = await waitFor(() => readHookPid(pidFile), "SessionStart hook pid", 60_000);
    assert.deepEqual(await hookShape(hookPid, leaders), detached);
    await session.teardown();
    const reaped = hookPid;
    await waitFor(() => (isReaped(reaped) ? true : undefined), `hook ${reaped} reaped`, 10_000);
  } finally {
    await cleanup(session);
    if (hookPid !== undefined && !isReaped(hookPid)) process.kill(hookPid, "SIGKILL");
  }
});

test("C-LIFE-10 stop reaps a SessionEnd hook that outlasts the graceful window", {
  skip: skipIf(skipReason("claude")),
  timeout: 180_000,
}, async () => {
  const { session, leaders, pidFile } = await startWithSlowHook("SessionEnd");
  let hookPid: number | undefined;
  try {
    await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 60_000);
    // Claude runs SessionEnd on SIGTERM and waits for it, so stop() escalates.
    const stopping = session.stop();
    stopping.catch(() => {}); // Observed below; keeps an early failure from going unhandled.
    hookPid = await waitFor(() => readHookPid(pidFile), "SessionEnd hook pid", 10_000);
    assert.deepEqual(await hookShape(hookPid, leaders), detached);
    await stopping;
    const reaped = hookPid;
    await waitFor(() => (isReaped(reaped) ? true : undefined), `hook ${reaped} reaped`, 10_000);
  } finally {
    await cleanup(session);
    if (hookPid !== undefined && !isReaped(hookPid)) process.kill(hookPid, "SIGKILL");
  }
});

test("C-LIFE-10 teardown reaps a Codex hook running in its own process group", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 180_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const pidFile = join(project.cwd, "hook.pid");
  const hook = `{type="command",command=${JSON.stringify(holdCommand(pidFile))},timeout=600}`;
  const before = new Set(childPids(process.pid));
  let session: CodexSessionApi | undefined;
  let hookPid: number | undefined;
  try {
    // Codex refuses the model before using any quota; UserPromptSubmit runs first.
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      autoupdate: false,
      model: "gpt-elwood-nonexistent-acceptance-probe",
      configOverrides: [`hooks.UserPromptSubmit=[{matcher="",hooks=[${hook}]}]`],
    });
    const leaders = childPids(process.pid).filter((pid) => !before.has(pid));
    session.sendMessage("hello").catch(() => undefined); // held by the hook until teardown
    hookPid = await waitFor(() => readHookPid(pidFile), "UserPromptSubmit hook pid", 60_000);
    assert.deepEqual(await hookShape(hookPid, leaders), detached);
    await session.teardown();
    const reaped = hookPid;
    await waitFor(() => (isReaped(reaped) ? true : undefined), `hook ${reaped} reaped`, 10_000);
  } finally {
    await cleanup(session);
    sandbox.dispose();
    if (hookPid !== undefined && !isReaped(hookPid)) process.kill(hookPid, "SIGKILL");
  }
});
