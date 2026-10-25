/**
 * A Codex session reads its configured default from, and restores, the config.toml fixed at
 * its launch, even after `CODEX_HOME` in Elwood's environment changes. Covers PRD §5.3,
 * C-API-23, and C-CODEX-14.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { useCodexHome } from "../helpers/codex-home.ts";
import { asScreen, codexPickerCurrentMarkerOnly } from "../helpers/model-pickers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  driveSetModel,
  restoreCodexHome,
  sandboxCodexHome,
  until,
  userConfig,
} from "./session-models-helpers.ts";

afterEach(() => {
  resetFakes();
  restoreCodexHome();
});

const laterConfigText = 'model = "gpt-5.4"\n\n[hooks]\n';

/** Launches under `<cwd>/codex-home` (configured `gpt-5.5`), then repoints `CODEX_HOME`. */
async function startThenRepoint() {
  const cwd = tempDir();
  const launchConfig = sandboxCodexHome(cwd);
  installFakes();
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd);
  await until(() => session.status === "ready", { label: "codex ready" });
  mkdirSync(join(cwd, "later-home"));
  const laterConfig = useCodexHome(join(cwd, "later-home"));
  writeFileSync(laterConfig, laterConfigText);
  return { session, launchConfig, laterConfig };
}

test("C-API-23 listModels reads the default from the config fixed at launch", async () => {
  const { session } = await startThenRepoint();
  const listing = session.listModels({ timeoutMs: 30_000 });
  await expect.poll(() => ptys[0]!.writes.join("").includes("/model\r")).toBe(true);
  ptys[0]!.emitData(asScreen(codexPickerCurrentMarkerOnly));
  await expect.poll(() => ptys[0]!.writes.includes("\u001b")).toBe(true);
  ptys[0]!.emitData(asScreen("› "));
  const defaults = (await listing).filter((option) => option.isDefault).map((option) => option.id);
  expect(defaults).toEqual(["gpt-5.5"]);
});

test("C-CODEX-14 setModel restores the config fixed at launch, not the current env's", async () => {
  const { session, launchConfig, laterConfig } = await startThenRepoint();
  const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
  await driveSetModel(launchConfig, userConfig.replace('"gpt-5.5"', '"gpt-5.4"'));
  await setting;
  expect(readFileSync(launchConfig, "utf8")).toBe(userConfig);
  expect(readFileSync(laterConfig, "utf8")).toBe(laterConfigText);
});
