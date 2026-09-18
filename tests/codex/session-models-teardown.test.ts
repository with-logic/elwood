/**
 * `torn_down` is recorded by teardown itself, so it is not evidence the Codex process
 * exited. A setModel interrupted by a teardown whose termination did not take must
 * still wait out the exit bound before restoring config.toml (PRD §5.7, C-CODEX-14).
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { withCodexConfigLock } from "../../src/codex/config/lock.ts";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  driveUntilConfigWritten,
  restoreCodexHome,
  sandboxCodexHome,
  userConfig,
} from "./session-models-helpers.ts";

afterEach(() => {
  resetFakes();
  restoreCodexHome();
});

const switched = 'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n';

test("C-CODEX-14 a teardown that did not kill the CLI does not release the restore", async () => {
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  installFakes();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  await expect.poll(() => session.status).toBe("ready");
  const setting = session.setModel("gpt-5.4", { timeoutMs: 20_000 }).catch((error) => error.code);
  // Codex has persisted the selection; its confirmation is still in flight.
  await driveUntilConfigWritten(configPath, switched);
  const pty = ptys[0]!;
  // The signal does not take: the process stays alive, so teardown reports `torn_down`
  // without the PTY ever exiting. That status must not be read as proof the CLI is gone.
  pty.kill = () => {};
  const tearing = session.teardown().catch((error) => error.message);
  // The caller is released at once; the restore is what must keep waiting.
  expect(await setting).toBe("session_not_running");
  // Teardown records `torn_down` even though its signal did not take, so the session
  // reports a terminal status while the CLI is still alive and able to write its
  // selection. The restore must NOT have fired off the back of that status.
  await expect.poll(() => session.status, { timeout: 4_000 }).toBe("torn_down");
  expect(readFileSync(configPath, "utf8")).toBe(switched);
  // The five-second bound still releases it, so a stuck CLI cannot hold the lock for good.
  await expect
    .poll(() => readFileSync(configPath, "utf8"), { timeout: 8_000, interval: 100 })
    .toBe(userConfig);
  await tearing;
  pty.emitExit({ exitCode: 0 });
}, 30_000);

/**
 * The exit barrier must also be LATCHED: `waitForCliExit` runs after the picker rejected, by
 * which time the exit that closed the session has usually already fired. Subscribing
 * without checking that latch would make every ordinary close wait out the full bound.
 */
test("C-CODEX-14 a CLI that already exited restores without waiting out the bound", async () => {
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  installFakes();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  await expect.poll(() => session.status).toBe("ready");
  const setting = session.setModel("gpt-5.4", { timeoutMs: 20_000 }).catch((error) => error.code);
  await driveUntilConfigWritten(configPath, switched);
  const started = Date.now();
  // The fake PTY exits synchronously on kill, so the exit precedes the restore decision.
  await session.kill().catch(() => undefined);
  expect(await setting).toBe("session_not_running");
  await expect.poll(() => readFileSync(configPath, "utf8"), { timeout: 4_000 }).toBe(userConfig);
  expect(Date.now() - started).toBeLessThan(4_000);
}, 30_000);

/**
 * The session queue slot must be claimed BEFORE the process-wide `config.toml` lock. With
 * the lock first, a `sendMessage` issued right after `setModel` dispatched while the switch
 * was still waiting on another session's transaction — sending under the OLD model, which
 * is the FIFO violation the exclusive slot exists to prevent (C-API-55, C-CODEX-14).
 */
test("C-API-55 a message cannot overtake a setModel waiting for the config lock", async () => {
  const cwd = tempDir();
  sandboxCodexHome(cwd);
  installFakes();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  await expect.poll(() => session.status).toBe("ready");
  // Another session in this process holds the config lock.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void withCodexConfigLock(() => held);
  const setting = session.setModel("gpt-5.4", { timeoutMs: 8_000 }).catch(() => undefined);
  const message = session.sendMessage("hello").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 400));
  // Nothing reached the PTY: the queued message is behind the slot, not ahead of it.
  expect(ptys[0]!.writes.filter((write) => String(write).includes("hello"))).toEqual([]);
  release();
  await Promise.allSettled([setting, message]);
}, 30_000);
