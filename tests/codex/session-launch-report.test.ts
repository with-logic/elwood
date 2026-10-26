/**
 * The life of a Codex launch's `CODEX_HOME` report: a model operation that starts before the
 * launch shell finishes it waits for it, it goes away when its launch ends, and a start whose
 * report step failed says so. Covers PRD §4.2, §8.1, and C-CODEX-24.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import type { PtySpawnOptions } from "../../src/pty/types.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { codexHomeReportPath } from "../helpers/codex-home.ts";
import { FakePty } from "../helpers/fake-pty.ts";
import { exitingDuringStartup, rejection, startupExit } from "../helpers/startup-exit.ts";
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

/** The report path of the first Codex launch. */
function firstReport(): string {
  const report = codexHomeReportPath(ptys[0]!.options.args);
  if (report === undefined) throw new Error("the first launch has no CODEX_HOME report step");
  return report;
}

async function readySession() {
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  installFakes();
  const session = await startCodex({ cwd });
  onTestFinished(() => session.stop());
  await becomeReady(session.elwoodSessionId, cwd);
  await until(() => session.status === "ready", { label: "codex ready" });
  return { session, configPath };
}

test("C-CODEX-24 a setModel that starts before the report is finished waits for it", async () => {
  const { session, configPath } = await readySession();
  const report = firstReport();
  const finished = readFileSync(report, "utf8");
  writeFileSync(report, finished.slice(0, finished.indexOf("\0") + 1));
  const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(ptys[0]!.writes.join(""), "no picker before the report").not.toContain("/model");
  writeFileSync(report, finished);
  await driveSetModel(configPath, userConfig.replace('"gpt-5.5"', '"gpt-5.4"'));
  await setting;
  expect(readFileSync(configPath, "utf8")).toBe(userConfig);
});

test("C-CODEX-24 a launch's report is removed when its PTY exits", async () => {
  const { session } = await readySession();
  const report = firstReport();
  expect(existsSync(report)).toBe(true);
  await session.stop();
  await until(() => !existsSync(report), { label: "report removed" });
});

test("C-CODEX-24 a start that fails after the report was written removes it", async () => {
  installFakes();
  setPtyFactoryForTests(exitingDuringStartup(ptys));
  const failure = await rejection(startCodex({ cwd: tempDir() }));
  expect(failure).toMatchObject({ code: "codex_start_failed", details: startupExit });
  expect(failure.details["phase"]).toBeUndefined();
  expect(existsSync(firstReport())).toBe(false);
});

/** A launch shell that exits with status 73 during startup, with or without its report. */
function exitingWith73(reported: boolean) {
  return (options: PtySpawnOptions) => {
    const pty = new FakePty(options, 1000 + ptys.length);
    ptys.push(pty);
    if (!reported) rmSync(firstReport()); // the launch shell could not write it
    const timer = setInterval(() => {
      if (pty.exitHandlers.length === 0) return;
      clearInterval(timer);
      pty.emitExit({ exitCode: 73 });
    }, 0);
    return pty;
  };
}

test("C-CODEX-24 a start whose report step failed says so, naming the report", async () => {
  installFakes();
  setPtyFactoryForTests(exitingWith73(false));
  const failure = await rejection(startCodex({ cwd: tempDir() }));
  expect(failure).toMatchObject({
    code: "codex_start_failed",
    details: { exitCode: 73, phase: "codex_home_report", path: firstReport() },
  });
});

test("C-CODEX-24 a Codex that exits 73 after its report keeps its own start failure", async () => {
  installFakes();
  setPtyFactoryForTests(exitingWith73(true));
  const failure = await rejection(startCodex({ cwd: tempDir() }));
  expect(failure).toMatchObject({ code: "codex_start_failed", details: { exitCode: 73 } });
  expect(failure.details["phase"]).toBeUndefined();
});

test("C-CODEX-24 a report that cannot be removed does not stop the session's exit", async () => {
  const { session } = await readySession();
  const report = firstReport();
  rmSync(report);
  mkdirSync(join(report, "kept"), { recursive: true }); // removing it without recursion fails
  onTestFinished(() => rmSync(report, { recursive: true, force: true }));
  const exited = new Promise((resolve) => session.on("terminal:exit", resolve));
  ptys[0]!.emitExit({ exitCode: 0 });
  await exited;
});
