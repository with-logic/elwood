/**
 * Reading the launch shell's `CODEX_HOME` report: an unfinished report is waited for until the
 * caller's signal aborts, and anything that is not a report fails closed. Covers PRD §4.2 and
 * §5.3.
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { reportedCodexConfigPath } from "../../src/codex/config/home.ts";
import { tempDir } from "../helpers/tmp.ts";

function reportPath(): string {
  return join(realpathSync(tempDir("elwood-codex-report-")), "codex-home");
}

function read(report: string): Promise<string> {
  return reportedCodexConfigPath(report, AbortSignal.timeout(2_000));
}

describe("reading the report", () => {
  test("a report still being written is waited for, however much of it is there", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
    const report = reportPath();
    // A relative CODEX_HOME, so a report accepted before its directory is complete would
    // resolve against the wrong one.
    const codexWorkingDirectory = realpathSync(tempDir("elwood-codex-cwd-"));
    mkdirSync(join(codexWorkingDirectory, "codex-home"));
    const values = ["codex-home", "/Users/elwood-test", codexWorkingDirectory].join("\0");
    let settled = false;
    const reading = reportedCodexConfigPath(report, new AbortController().signal);
    reading.then(
      () => (settled = true),
      () => (settled = true),
    );
    const partials = ["", "codex-home", "codex-home\0", "codex-home\0/Users/elwood-test\0", values];
    for (const partial of [undefined, ...partials]) {
      if (partial !== undefined) writeFileSync(report, partial);
      await vi.advanceTimersByTimeAsync(100);
      expect(settled, `settled on ${JSON.stringify(partial)}`).toBe(false);
    }
    writeFileSync(report, `${values}\0`);
    await vi.advanceTimersByTimeAsync(25);
    expect(await reading).toBe(join(codexWorkingDirectory, "codex-home", "config.toml"));
  });

  test("a report that never arrives rejects with the reason its signal aborted for", async () => {
    const deadline = new Error("deadline");
    const aborted = new AbortController();
    setTimeout(() => aborted.abort(deadline), 80);
    await expect(reportedCodexConfigPath(reportPath(), aborted.signal)).rejects.toBe(deadline);
  });

  test("an already-aborted signal rejects without waiting", async () => {
    const aborted = new AbortController();
    aborted.abort(new Error("closed"));
    await expect(reportedCodexConfigPath(reportPath(), aborted.signal)).rejects.toThrow("closed");
  });

  test.each([
    ["four values", "/a\0/b\0/c\0/d\0"],
    ["a fourth, unterminated value", "/a\0/b\0/c\0/d"],
  ])("a report with %s is refused", async (_name, text) => {
    const report = reportPath();
    writeFileSync(report, text);
    await expect(read(report)).rejects.toMatchObject({
      code: "model_automation_failed",
      details: { path: report, cause: "The report is not three NUL-terminated values." },
    });
  });

  test("a report that cannot be read is a model_automation_failed with its errno", async () => {
    const report = reportPath();
    mkdirSync(report);
    await expect(read(report)).rejects.toMatchObject({
      code: "model_automation_failed",
      details: { path: report, errno: "EISDIR" },
    });
  });

  test("a CODEX_HOME that does not exist is a model_automation_failed naming it", async () => {
    const report = reportPath();
    writeFileSync(report, "missing-home\0/Users/elwood-test\0/w\0");
    await expect(read(report)).rejects.toMatchObject({
      code: "model_automation_failed",
      details: { path: report, codexHome: "/w/missing-home", errno: "ENOENT" },
    });
  });
});
