/**
 * Unit tests for the Codex config compare-and-swap restore.
 * Covers PRD §5.3 and C-CODEX-14.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  codexConfigPath,
  restoreCodexConfig,
  snapshotCodexConfig,
} from "../../src/codex/config-restore.ts";

const original = process.env["CODEX_HOME"];

afterEach(() => {
  if (original === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = original;
});

function sandbox(contents: string): string {
  const home = mkdtempSync(join(tmpdir(), "codex-restore-"));
  process.env["CODEX_HOME"] = home;
  writeFileSync(join(home, "config.toml"), contents);
  return join(home, "config.toml");
}

const baseConfig = 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\nfoo = 1\n\n[hooks]\n';

describe("codex config restore", () => {
  test("C-CODEX-14 restores when only root model keys changed", () => {
    const path = sandbox(baseConfig);
    const snapshot = snapshotCodexConfig();
    writeFileSync(
      path,
      'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\nfoo = 1\n\n[hooks]\n',
    );
    expect(restoreCodexConfig(snapshot)).toBe("restored");
    expect(readFileSync(path, "utf8")).toBe(baseConfig);
  });

  test("C-CODEX-14 reports unchanged when the picker wrote nothing", () => {
    const path = sandbox(baseConfig);
    expect(restoreCodexConfig(snapshotCodexConfig())).toBe("unchanged");
    expect(readFileSync(path, "utf8")).toBe(baseConfig);
  });

  test("C-CODEX-14 skips instead of clobbering concurrent edits", () => {
    const path = sandbox(baseConfig);
    const snapshot = snapshotCodexConfig();
    const concurrent = 'model = "gpt-5.4"\nfoo = 2\n\n[hooks]\n';
    writeFileSync(path, concurrent);
    expect(restoreCodexConfig(snapshot)).toBe("skipped");
    expect(readFileSync(path, "utf8")).toBe(concurrent);
  });

  test("C-CODEX-14 model keys inside tables are protected, not stripped", () => {
    const path = sandbox('model = "gpt-5.5"\n\n[profiles.fast]\nmodel = "gpt-5.4-mini"\n');
    const snapshot = snapshotCodexConfig();
    writeFileSync(path, 'model = "gpt-5.4"\n\n[profiles.fast]\nmodel = "changed"\n');
    expect(restoreCodexConfig(snapshot)).toBe("skipped");
  });

  test("C-CODEX-14 missing snapshot or file skips safely", () => {
    sandbox(baseConfig);
    expect(restoreCodexConfig(undefined)).toBe("skipped");
    process.env["CODEX_HOME"] = mkdtempSync(join(tmpdir(), "codex-empty-"));
    expect(snapshotCodexConfig()).toBeUndefined();
    expect(restoreCodexConfig(baseConfig)).toBe("skipped");
  });

  test("codexConfigPath falls back to the home directory", () => {
    delete process.env["CODEX_HOME"];
    expect(codexConfigPath().endsWith("/.codex/config.toml")).toBe(true);
  });
});
