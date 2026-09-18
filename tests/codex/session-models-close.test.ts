/**
 * A setModel interrupted by session close restores config.toml only once the CLI is
 * gone (PRD §5.7, C-CODEX-14, C-API-55).
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
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

test("C-CODEX-14 a setModel interrupted by kill restores config.toml after the CLI exits", async () => {
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  installFakes();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  await expect.poll(() => session.status).toBe("ready");
  const events: string[] = [];
  const setting = session.setModel("gpt-5.4", { timeoutMs: 20_000 }).catch((error) => {
    events.push("rejected");
    return error.code;
  });
  // The CLI has persisted the selection and its confirmation is still in flight.
  await driveUntilConfigWritten(
    configPath,
    'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n',
  );
  const pty = ptys[0]!;
  const kill = pty.kill.bind(pty);
  // A real CLI keeps running for a moment after the signal and can still write its config.
  pty.kill = (signal?: string) => {
    setTimeout(() => {
      events.push(readFileSync(configPath, "utf8") === userConfig ? "exit:restored" : "exit");
      kill(signal);
    }, 150);
  };
  await session.kill();
  expect(await setting).toBe("session_not_running");
  // The caller is not kept waiting for the process; the restore is.
  expect(events).toEqual(["rejected", "exit"]);
  await expect.poll(() => readFileSync(configPath, "utf8")).toBe(userConfig);
}, 30_000);

test("C-CODEX-14 a CLI that never reports exit cannot hold the restore past its bound", async () => {
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  installFakes();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  await expect.poll(() => session.status).toBe("ready");
  const setting = session.setModel("gpt-5.4", { timeoutMs: 20_000 }).catch((error) => error.code);
  await driveUntilConfigWritten(
    configPath,
    'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n',
  );
  // The signal is swallowed: no exit event, so the session never turns terminal.
  ptys[0]!.kill = () => {};
  const killed = session.kill().catch((error) => error.message);
  expect(await setting).toBe("session_not_running");
  expect(readFileSync(configPath, "utf8")).not.toBe(userConfig);
  await expect
    .poll(() => readFileSync(configPath, "utf8"), { timeout: 8_000, interval: 100 })
    .toBe(userConfig);
  expect(await killed).toContain("did not exit");
  ptys[0]!.emitExit({ exitCode: 0 });
}, 30_000);
