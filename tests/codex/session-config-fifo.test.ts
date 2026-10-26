/**
 * A Codex config.toml the agent replaced with a FIFO fails model operations at once, with
 * its path and errno, and Elwood never waits on it (PRD §5.3, C-CODEX-25).
 */

import { rmSync } from "node:fs";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { fifoWithLateWriter } from "../helpers/fifo.ts";
import { asScreen, codexPickerCurrentMarkerOnly } from "../helpers/model-pickers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  driveUntilConfigWritten,
  restoreCodexHome,
  sandboxCodexHome,
  until,
  userConfig,
} from "./session-models-helpers.ts";

afterEach(() => {
  resetFakes();
  restoreCodexHome();
});

async function readySession() {
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  installFakes();
  const session = await startCodex({ cwd });
  onTestFinished(() => session.stop());
  await becomeReady(session.elwoodSessionId, cwd);
  await until(() => session.status === "ready");
  return { session, configPath };
}

/** Replaces the config with a FIFO whose writer is a second away. */
function becomeFifo(configPath: string): void {
  rmSync(configPath);
  fifoWithLateWriter(configPath, userConfig);
}

/** A ready session whose config.toml has become a FIFO. */
async function sessionWithFifoConfig() {
  const ready = await readySession();
  becomeFifo(ready.configPath);
  return ready;
}

test("C-CODEX-25 listModels rejects a FIFO config without waiting for its writer", async () => {
  const { session, configPath } = await sessionWithFifoConfig();
  const listing = session.listModels({ timeoutMs: 30_000 });
  await until(() => ptys[0]!.writes.join("").includes("/model\r"));
  ptys[0]!.emitData(asScreen(codexPickerCurrentMarkerOnly));
  await until(() => ptys[0]!.writes.includes("\u001b"));
  ptys[0]!.emitData(asScreen("› "));
  await expect(listing).rejects.toMatchObject({
    code: "model_automation_failed",
    details: { path: configPath, code: "EFTYPE" },
  });
});

test("C-CODEX-25 setModel rejects a FIFO config before it opens the picker", async () => {
  const { session, configPath } = await sessionWithFifoConfig();
  await expect(session.setModel("gpt-5.4", { timeoutMs: 2_000 })).rejects.toMatchObject({
    code: "model_automation_failed",
    details: { path: configPath, code: "EFTYPE" },
  });
  expect(ptys[0]!.writes.join("")).not.toContain("/model");
});

test("C-CODEX-25 setModel rejects with the path and errno when the config is a FIFO at the restore", async () => {
  const { session, configPath } = await readySession();
  const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
  await driveUntilConfigWritten(configPath, userConfig.replace('"gpt-5.5"', '"gpt-5.4"'));
  becomeFifo(configPath);
  ptys[0]!.emitData(asScreen("• Model changed to gpt-5.4 medium\n› "));
  await expect(setting).rejects.toMatchObject({
    code: "model_automation_failed",
    message: "Could not read the Codex config to restore its default model.",
    details: { path: configPath, code: "EFTYPE" },
  });
});
