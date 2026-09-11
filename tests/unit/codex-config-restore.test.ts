/**
 * Unit tests for the Codex config compare-and-swap restore.
 * Covers PRD §5.3 and C-CODEX-14.
 */

import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  codexConfigPath,
  restoreCodexConfig,
  restoreFailureRaw,
  snapshotCodexConfig,
} from "../../src/codex/config/restore.ts";

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

  test("C-CODEX-14 a file that vanished during the switch is skipped, never recreated", () => {
    process.env["CODEX_HOME"] = mkdtempSync(join(tmpdir(), "codex-empty-"));
    expect(snapshotCodexConfig()).toBeUndefined();
    expect(restoreCodexConfig(baseConfig)).toBe("skipped");
    expect(readdirSync(process.env["CODEX_HOME"])).toEqual([]);
  });

  test("C-CODEX-14 with no snapshot, a config.toml the picker created is `no_snapshot`", () => {
    // No config existed before the switch: the created file is left in place and the
    // outcome names the real situation, not a concurrent edit.
    const path = sandbox('model = "gpt-5.4"\n');
    expect(restoreCodexConfig(undefined)).toBe("no_snapshot");
    expect(readFileSync(path, "utf8")).toBe('model = "gpt-5.4"\n');
  });

  test("C-CODEX-14 with no snapshot and still no file there is nothing to report", () => {
    process.env["CODEX_HOME"] = mkdtempSync(join(tmpdir(), "codex-empty-"));
    expect(restoreCodexConfig(undefined)).toBe("unchanged");
  });

  test("C-CODEX-14 the restore is atomic: no temp file is left behind and the mode survives", () => {
    const path = sandbox(baseConfig);
    chmodSync(path, 0o640);
    const snapshot = snapshotCodexConfig();
    writeFileSync(
      path,
      'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\nfoo = 1\n\n[hooks]\n',
    );
    expect(restoreCodexConfig(snapshot)).toBe("restored");
    expect(readFileSync(path, "utf8")).toBe(baseConfig);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dirname(path))).toEqual(["config.toml"]); // the temp file was renamed away
  });

  test("C-CODEX-14 a symlinked config.toml is written THROUGH to its target", () => {
    // Renaming onto the link path would replace the user's symlink with a regular
    // file; the restore must land in the resolved target and leave the link intact.
    const home = mkdtempSync(join(tmpdir(), "codex-link-"));
    const target = join(home, "real-config.toml");
    writeFileSync(target, baseConfig);
    symlinkSync(target, join(home, "config.toml"));
    process.env["CODEX_HOME"] = home;
    const snapshot = snapshotCodexConfig();
    writeFileSync(
      target,
      'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\nfoo = 1\n\n[hooks]\n',
    );
    expect(restoreCodexConfig(snapshot)).toBe("restored");
    expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(baseConfig);
    expect(readdirSync(home).sort()).toEqual(["config.toml", "real-config.toml"]);
  });

  test("codexConfigPath falls back to the home directory", () => {
    delete process.env["CODEX_HOME"];
    expect(codexConfigPath().endsWith("/.codex/config.toml")).toBe(true);
  });

  test("C-CODEX-14 restoreFailureRaw is content-free: path + bounded errno code only", () => {
    // An errno error contributes its string code; anything else (a message-only
    // Error, a non-Error) normalizes to UNKNOWN so no raw message text is persisted.
    expect(restoreFailureRaw("/c.toml", Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
      "/c.toml (EACCES)",
    );
    expect(restoreFailureRaw("/c.toml", new Error("secret leaked here"))).toBe("/c.toml (UNKNOWN)");
    expect(restoreFailureRaw("/c.toml", "boom")).toBe("/c.toml (UNKNOWN)");
  });
});
