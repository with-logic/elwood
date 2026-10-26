/**
 * Real-CLI verification that teardown() reaps the agent process group with no
 * orphaned survivors (PRD §9.4, C-LIFE-10). This exercises the failure-safe,
 * retryable process-group cleanup: after teardown the CLI child that the PTY
 * spawned under this test process must be gone. Claude and Codex start every hook
 * command with `setsid()`, so the hook tests also prove
 * that a hook still running when Elwood kills the CLI — in its own session and group —
 * is reaped: on Claude's `teardown()`, on a Claude `stop()` whose SessionEnd hook
 * outlasts the graceful window, and on Codex's `teardown()`.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { childPids } from "../../dev/child-lookup.ts";
import {
  type ClaudeSessionApi,
  type CodexSessionApi,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import { killGroupsWhoseCommandHas } from "../helpers/process-liveness.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";
import {
  detached,
  hookShape,
  isReaped,
  readHookPid,
  slowHold,
  startWithSlowHook,
} from "./slow-hook.ts";

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

test("C-LIFE-10 teardown reaps a Claude hook running in its own process group", {
  skip: skipIf(skipReason("claude")),
  timeout: 180_000,
}, async () => {
  const { session, leaders, pidFile, marker } = await startWithSlowHook("SessionStart");
  try {
    const hookPid = await waitFor(() => readHookPid(pidFile), "SessionStart hook pid", 60_000);
    assert.deepEqual(await hookShape(hookPid, leaders), detached);
    await session.teardown();
    await waitFor(() => (isReaped(hookPid) ? true : undefined), `hook ${hookPid} reaped`, 10_000);
  } finally {
    await cleanup(session);
    killGroupsWhoseCommandHas(marker);
  }
});

test("C-LIFE-10 stop reaps a SessionEnd hook that outlasts the graceful window", {
  skip: skipIf(skipReason("claude")),
  timeout: 180_000,
}, async () => {
  const { session, leaders, pidFile, marker } = await startWithSlowHook("SessionEnd");
  try {
    await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 60_000);
    // Claude runs SessionEnd on SIGTERM and waits for it, so stop() escalates.
    const stopping = session.stop();
    stopping.catch(() => {}); // Observed below; keeps an early failure from going unhandled.
    const hookPid = await waitFor(() => readHookPid(pidFile), "SessionEnd hook pid", 10_000);
    assert.deepEqual(await hookShape(hookPid, leaders), detached);
    await stopping;
    await waitFor(() => (isReaped(hookPid) ? true : undefined), `hook ${hookPid} reaped`, 10_000);
  } finally {
    await cleanup(session);
    killGroupsWhoseCommandHas(marker);
  }
});

test("C-LIFE-10 teardown reaps a Codex hook running in its own process group", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 180_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const pidFile = join(project.cwd, "hook.pid");
  const { command, marker } = slowHold(pidFile);
  const hook = `{type="command",command=${JSON.stringify(command)},timeout=600}`;
  const before = new Set(childPids(process.pid));
  let session: CodexSessionApi | undefined;
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
    const hookPid = await waitFor(() => readHookPid(pidFile), "UserPromptSubmit hook pid", 60_000);
    assert.deepEqual(await hookShape(hookPid, leaders), detached);
    await session.teardown();
    await waitFor(() => (isReaped(hookPid) ? true : undefined), `hook ${hookPid} reaped`, 10_000);
  } finally {
    await cleanup(session);
    sandbox.dispose();
    killGroupsWhoseCommandHas(marker);
  }
});
