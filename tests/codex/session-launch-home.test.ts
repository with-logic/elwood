/**
 * A Codex session reads its configured default from, and restores, the config.toml of the
 * `CODEX_HOME` its own launch shell reported, never the one Elwood's environment names. A
 * session whose report never arrives neither lists a default nor switches. Covers PRD §4.2,
 * §5.3, and C-CODEX-24.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { currentPtyFactory, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { codexHomeReportPath } from "../helpers/codex-home.ts";
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

const shellConfigText = 'model = "gpt-5.4"\nmodel_reasoning_effort = "low"\n\n[hooks]\n';

/**
 * Elwood's environment names `<cwd>/codex-home` (configured `gpt-5.5`). The launch shell
 * reports the RELATIVE `shell-home` (configured `gpt-5.4`), which Codex resolves from the
 * session cwd it starts in, unless `report` writes something else.
 */
async function startUnderShellHome(
  report = (path: string, cwd: string) => writeFileSync(path, `shell-home\0/h\0${cwd}\0`),
) {
  installFakes();
  const cwd = tempDir();
  const elwoodConfig = sandboxCodexHome(cwd);
  mkdirSync(join(cwd, "shell-home"));
  const shellConfig = join(cwd, "shell-home", "config.toml");
  writeFileSync(shellConfig, shellConfigText);
  const fake = currentPtyFactory();
  const reports: string[] = [];
  setPtyFactoryForTests((options) => {
    const pty = fake(options);
    const reportPath = codexHomeReportPath(options.args);
    if (reportPath !== undefined) {
      reports.push(reportPath);
      report(reportPath, options.cwd);
    }
    return pty;
  });
  const session = await startCodex({ cwd });
  onTestFinished(() => session.stop());
  await becomeReady(session.elwoodSessionId, cwd);
  await until(() => session.status === "ready", { label: "codex ready" });
  return { session, cwd, elwoodConfig, shellConfig, reports };
}

/** Lists the session's models through the fake picker and returns the default ids. */
async function listDefaults(session: Awaited<ReturnType<typeof startCodex>>, pty = ptys[0]!) {
  const before = pty.writes.length;
  const listing = session.listModels({ timeoutMs: 30_000 });
  await until(() => pty.writes.slice(before).join("").includes("/model\r"));
  pty.emitData(asScreen(codexPickerCurrentMarkerOnly));
  await until(() => pty.writes.slice(before).includes("\u001b"));
  pty.emitData(asScreen("› "));
  return (await listing).filter((option) => option.isDefault).map((option) => option.id);
}

test("C-CODEX-24 listModels marks the default configured in the CODEX_HOME the launch reported", async () => {
  const { session, reports } = await startUnderShellHome();
  // The launch shell writes its report, and exits instead of starting Codex if it cannot.
  expect(ptys[0]!.options.args.at(-1)).toMatch(/^\/bin\/sh -c .+ > '.+' \|\| exit 73; exec codex /);
  expect(await listDefaults(session)).toEqual(["gpt-5.4"]);
  rmSync(reports[0]!); // read once at first use, then kept for the session
  expect(await listDefaults(session)).toEqual(["gpt-5.4"]);
});

test("C-CODEX-24 setModel restores the reported config.toml and leaves Elwood's alone", async () => {
  const { session, elwoodConfig, shellConfig } = await startUnderShellHome();
  const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
  await driveSetModel(shellConfig, shellConfigText.replace('"low"', '"medium"'));
  await setting;
  expect(readFileSync(shellConfig, "utf8")).toBe(shellConfigText);
  expect(readFileSync(elwoodConfig, "utf8")).toBe(userConfig);
});

test("C-CODEX-24 a report that never arrives fails setModel at its deadline, naming it, before the picker", async () => {
  const { session, reports } = await startUnderShellHome((path) => rmSync(path));
  await expect(session.setModel("gpt-5.4", { timeoutMs: 300 })).rejects.toMatchObject({
    code: "model_automation_failed",
    details: { path: reports[0] },
  });
  expect(ptys[0]!.writes.join("")).not.toContain("/model");
});

test("C-CODEX-24 a report that is not one fails listModels, naming the report", async () => {
  const { session, reports } = await startUnderShellHome((path) => writeFileSync(path, "\0\0\0\0"));
  await expect(listDefaults(session)).rejects.toMatchObject({
    code: "model_automation_failed",
    details: { path: reports[0], cause: "The report is not three NUL-terminated values." },
  });
});

test("C-CODEX-24 a resumed session reads its default from the CODEX_HOME its own launch reported", async () => {
  // The resumed launch's startup files export another home, configured `gpt-5.4-mini`.
  const { session, cwd } = await startUnderShellHome((path, launchCwd) => {
    const home = ptys.length > 1 ? "resumed" : "shell-home"; // the launch's PTY is already made
    if (home === "resumed") {
      mkdirSync(join(launchCwd, home), { recursive: true });
      writeFileSync(join(launchCwd, home, "config.toml"), 'model = "gpt-5.4-mini"\n');
    }
    writeFileSync(path, `${home}\0/h\0${launchCwd}\0`);
  });
  expect(await listDefaults(session)).toEqual(["gpt-5.4"]);
  await session.stop();
  const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
  onTestFinished(() => resumed.stop());
  ptys[1]!.emitData(asScreen("› "));
  await until(() => resumed.status === "ready", { label: "resumed codex ready" });
  expect(await listDefaults(resumed, ptys[1]!)).toEqual(["gpt-5.4-mini"]);
});
