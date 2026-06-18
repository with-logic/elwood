/**
 * Deterministic e2e coverage for resume and PTY edge flows.
 * Implements C-E2E-01 and C-E2E-04.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ElwoodError, resumeClaude, resumeCodex } from "../../src/index.ts";
import { currentPtyFactory } from "../../src/runtime/seams.ts";
import { createSessionRecord, writeSessionRecord } from "../../src/state/store.ts";
import { attachPtyTerminal } from "../../src/terminal/headless.ts";
import { makeProject, waitFor } from "./helpers.ts";

test("C-E2E-04 rejects cross-adapter resume from persisted state", async () => {
  const project = makeProject("claude");
  const codexRecord = createSessionRecord({
    stateDir: project.stateDir,
    cwd: project.cwd,
    id: "codex-record",
    adapter: "codex",
  });
  const claudeRecord = createSessionRecord({
    stateDir: project.stateDir,
    cwd: project.cwd,
    id: "claude-record",
  });
  writeSessionRecord({ ...codexRecord, codex: { resumeId: "codex-native" } });
  writeSessionRecord({ ...claudeRecord, claude: { resumeId: "claude-native" } });
  await assert.rejects(
    () =>
      resumeClaude({
        cwd: project.cwd,
        stateDir: project.stateDir,
        elwoodSessionId: "codex-record",
      }),
    hasCode("adapter_mismatch"),
  );
  await assert.rejects(
    () =>
      resumeCodex({
        cwd: project.cwd,
        stateDir: project.stateDir,
        elwoodSessionId: "claude-record",
      }),
    hasCode("adapter_mismatch"),
  );
});

test("C-E2E-01 real PTY terminal handles input resize and kill", { timeout: 30_000 }, async () => {
  const project = makeProject("claude");
  const pty = currentPtyFactory()({
    command: "/bin/cat",
    args: [],
    cwd: project.cwd,
    env: process.env,
    size: { cols: 40, rows: 10 },
  });
  let exited = false;
  pty.onExit(() => {
    exited = true;
  });
  const terminal = attachPtyTerminal({ cols: 40, rows: 10 }, pty, () => {});
  try {
    terminal.sendInput("hello from elwood\r");
    await waitFor(async () => {
      await terminal.settled();
      return terminal.snapshot().text.includes("hello from elwood") ? true : undefined;
    }, "real PTY echo");
    terminal.resize({ cols: 42, rows: 12 });
    pty.resize({ cols: 42, rows: 12 });
    assert.equal(terminal.size.cols, 42);
    pty.kill("SIGTERM");
    await waitFor(() => (exited ? true : undefined), "real PTY exit", 5_000);
    assert.doesNotThrow(() => pty.resize({ cols: 43, rows: 12 }));
  } finally {
    terminal.dispose();
    if (!exited) pty.kill("SIGKILL");
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ElwoodError && error.code === code;
}
