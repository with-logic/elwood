/**
 * Two Codex sessions started with the same `CODEX_HOME` in Elwood's environment, whose launch
 * shells report different homes, lock their own reported config files: neither one session's
 * `listModels` nor its `setModel` waits on the other's switch in progress (PRD §5.3,
 * C-CODEX-14, with C-CODEX-24).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexHomeReportPath } from "../helpers/codex-home.ts";
import { asScreen, codexPickerCurrentMarkerOnly } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  becomeReadyFor,
  driveSetModel,
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

/** Starts a session whose launch shell reports `home`, not Elwood's `CODEX_HOME`. */
async function startReportingHome(name: string, ptyIndex: number) {
  const cwd = tempDir();
  const home = join(cwd, name);
  mkdirSync(home);
  writeFileSync(join(home, "config.toml"), userConfig);
  const session = await startCodex({ cwd });
  onTestFinished(() => session.stop());
  const report = codexHomeReportPath(ptys[ptyIndex]!.options.args);
  if (report === undefined) throw new Error(`launch ${ptyIndex} has no CODEX_HOME report step`);
  writeFileSync(report, `${home}\0${process.env["HOME"]}\0${cwd}\0`);
  await becomeReadyFor(session.elwoodSessionId, cwd, ptyIndex);
  await until(() => session.status === "ready");
  return { session, configPath: join(home, "config.toml") };
}

// The driven operations get the picker suites' 30 s deadline and the polls their 20 s, so load
// cannot fail a correct run; a shared lock still fails it, at the listing's deadline.
test("C-CODEX-14 a listing never waits on a switch in another reported home", {
  timeout: 45_000,
}, async () => {
  installFakes();
  sandboxCodexHome(tempDir()); // one CODEX_HOME in Elwood's environment for both sessions
  const switching = await startReportingHome("first-home", 0);
  const listing = await startReportingHome("second-home", 1);
  const persisted = userConfig.replace('"gpt-5.5"', '"gpt-5.4"');
  const setting = switching.session.setModel("gpt-5.4", { timeoutMs: 30_000 });
  // The switch now holds its config file's lock, mid-picker, until it is confirmed.
  await driveUntilConfigWritten(switching.configPath, persisted, 0);
  // The switch is confirmed only after this listing completes, so a lock shared with the
  // switch would hold the listing until its deadline.
  const listed = listing.session.listModels({ timeoutMs: 30_000 });
  await until(() => ptys[1]!.writes.join("").includes("/model\r"));
  ptys[1]!.emitData(asScreen(codexPickerCurrentMarkerOnly));
  await until(() => ptys[1]!.writes.includes("\u001b"));
  ptys[1]!.emitData(asScreen("› "));
  expect((await listed).length).toBeGreaterThan(0);
  ptys[0]!.emitData(asScreen("• Model changed to gpt-5.4 medium\n› "));
  await setting;
});

test("C-CODEX-14 a switch never waits on a switch in another reported home", {
  timeout: 45_000,
}, async () => {
  installFakes();
  sandboxCodexHome(tempDir()); // one CODEX_HOME in Elwood's environment for both sessions
  const first = await startReportingHome("first-home", 0);
  const second = await startReportingHome("second-home", 1);
  const persisted = userConfig.replace('"gpt-5.5"', '"gpt-5.4"');
  let firstSettled = false;
  const holding = first.session.setModel("gpt-5.4", { timeoutMs: 30_000 }).finally(() => {
    firstSettled = true;
  });
  // The first switch now holds its config file's lock, mid-picker, until it is confirmed.
  await driveUntilConfigWritten(first.configPath, persisted, 0);
  // It is confirmed only after this switch completes, so a shared lock would hold this one
  // until its deadline.
  const switching = second.session.setModel("gpt-5.4", { timeoutMs: 30_000 });
  await driveSetModel(second.configPath, persisted, 1);
  await switching;
  expect(firstSettled, "the first switch still holds its lock").toBe(false);
  ptys[0]!.emitData(asScreen("• Model changed to gpt-5.4 medium\n› "));
  await holding;
});
