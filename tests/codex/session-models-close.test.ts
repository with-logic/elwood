/**
 * A setModel interrupted by session close restores config.toml only once the CLI is
 * gone (PRD §5.7, C-CODEX-14, C-API-55).
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { driveUntilConfigWritten, sandboxCodexHome, userConfig } from "./session-models-helpers.ts";

afterEach(resetFakes);

test("C-CODEX-14 a setModel interrupted by kill restores config.toml after the CLI exits", async () => {
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  installFakes();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  await expect.poll(() => session.status).toBe("ready");
  const setting = session.setModel("gpt-5.4", { timeoutMs: 20_000 }).catch((error) => error.code);
  // The CLI has persisted the selection and its confirmation is still in flight.
  await driveUntilConfigWritten(
    configPath,
    'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n',
  );
  const pty = ptys[0]!;
  const restoredWhileAlive: boolean[] = [];
  const kill = pty.kill.bind(pty);
  // A real CLI keeps running for a moment after the signal and can still write its config.
  pty.kill = (signal?: string) => {
    setTimeout(() => {
      restoredWhileAlive.push(readFileSync(configPath, "utf8") === userConfig);
      kill(signal);
    }, 150);
  };
  await session.kill();
  expect(await setting).toBe("session_not_running");
  expect(restoredWhileAlive).toEqual([false]);
  expect(readFileSync(configPath, "utf8")).toBe(userConfig);
}, 30_000);
