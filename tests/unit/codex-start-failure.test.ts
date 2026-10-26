/**
 * Only a start that failed in the launch shell's `CODEX_HOME` report step is attributed to it;
 * every other failure passes through unchanged. Covers PRD §4.2 and C-CODEX-24.
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { codexHomeReported } from "../../src/codex/config/home.ts";
import { explainCodexStartFailure } from "../../src/codex/pty.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { tempDir } from "../helpers/tmp.ts";

function reportPath(): string {
  return join(realpathSync(tempDir("elwood-codex-report-")), "codex-home");
}

describe("explainCodexStartFailure", () => {
  test.each([
    ["an untyped error", new Error("spawn failed")],
    ["another typed error", elwoodError("hook_bridge_failed", "No bridge.", { exitCode: 73 })],
    ["Codex's own exit status", elwoodError("codex_start_failed", "Exited.", { exitCode: 12 })],
  ])("C-CODEX-24 leaves %s alone", (_name, error) => {
    expect(explainCodexStartFailure(error, reportPath())).toBe(error);
  });

  test("C-CODEX-24 leaves status 73 alone once the report is finished: Codex ran", () => {
    const report = reportPath();
    writeFileSync(report, "/codex\0/h\0/w\0");
    const error = elwoodError("codex_start_failed", "Exited.", { exitCode: 73 });
    expect(explainCodexStartFailure(error, report)).toBe(error);
  });
});

describe("codexHomeReported", () => {
  test("C-CODEX-24 a report that cannot be read is not finished", () => {
    const report = reportPath();
    mkdirSync(report);
    expect(codexHomeReported(report)).toBe(false);
  });
});
