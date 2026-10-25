/**
 * Unit tests for reading the Codex configured default model from a real config.toml.
 * Covers PRD §5.3 `isDefault` and C-API-23.
 */

import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { configuredCodexModel } from "../../src/codex/config/default-model.ts";
import { restoreCodexHome, tempCodexHome } from "./helpers.ts";

afterEach(restoreCodexHome);

describe("Codex configured default model", () => {
  test("C-API-23 reads the root model key", () => {
    const path = tempCodexHome(
      'model = "gpt-6.1-sol" # pinned\nmodel_reasoning_effort = "high"\n\n[hooks]\n',
    );
    expect(configuredCodexModel(path)).toBe("gpt-6.1-sol");
  });

  test("C-API-23 reads a single-quoted root model", () => {
    const path = tempCodexHome("model = 'gpt-6-luna'\n");
    expect(configuredCodexModel(path)).toBe("gpt-6-luna");
  });

  test("C-API-23 ignores a model key that belongs to a table", () => {
    const path = tempCodexHome(
      'model_reasoning_effort = "medium"\n\n[profiles.fast]\nmodel = "gpt-6-luna"\n',
    );
    expect(configuredCodexModel(path)).toBeUndefined();
  });

  test("C-API-23 has no configured model without a config file", () => {
    const path = tempCodexHome();
    expect(configuredCodexModel(path)).toBeUndefined();
  });

  test("C-API-23 a config that exists but cannot be read is an error, never 'no default'", () => {
    const path = tempCodexHome();
    mkdirSync(path); // config.toml is a directory: EISDIR
    expect(() => configuredCodexModel(path)).toThrow(
      expect.objectContaining({
        code: "model_automation_failed",
        details: { path, code: "EISDIR" },
      }),
    );
  });

  test.each([
    ["bare", "[profiles.fast]"],
    ["double-quoted", '[profiles."fast"]'],
    ["single-quoted", "[ profiles.'fast' ]"],
  ])("C-API-23 prefers the model of the root-selected %s profile", (_name, header) => {
    const path = tempCodexHome(
      [
        'model = "gpt-6.1-sol"',
        'profile = "fast"',
        "",
        "[profiles.deep]",
        'model = "gpt-6-astra"',
        "",
        header,
        'model = "gpt-6-luna"',
        "",
        "[profiles.fast.extra]",
        'model = "gpt-5.6-sol"',
      ].join("\n"),
    );
    expect(configuredCodexModel(path)).toBe("gpt-6-luna");
  });

  test("C-API-23 prefers the model of a single-quoted root-selected profile", () => {
    const path = tempCodexHome(
      `model = "gpt-6.1-sol"\nprofile = 'fast'\n\n[profiles.fast]\nmodel = "gpt-6-luna"\n`,
    );
    expect(configuredCodexModel(path)).toBe("gpt-6-luna");
  });

  test.each([
    ["a multiline basic string", ['notes = """', 'model = "gpt-wrong"', "", '"""']],
    ["a multiline literal string", ["notes = '''", "[profiles.wrong]", "'''"]],
    ["an escaped quote in a multiline string", ['notes = """say \\"""', 'model = "x"', '"""']],
    ["a comment quoting a delimiter", ['# notes = """']],
    [
      "single-line strings quoting delimiters",
      [`a = "'''"`, `b = '"""'`, "c = 'C:\\' # it's \"\"\""],
    ],
    ["a multiline string closed on its line", ['notes = """one""" # """']],
    ["an unterminated single-line string", ['notes = "open']],
  ])("C-API-23 never reads a key or header from inside %s", (_name, before) => {
    const path = tempCodexHome([...before, 'model = "gpt-6.1-sol"', "", "[hooks]"].join("\n"));
    expect(configuredCodexModel(path)).toBe("gpt-6.1-sol");
  });

  test("C-API-23 falls back to the root model when the selected profile sets none", () => {
    const path = tempCodexHome(
      'model = "gpt-6.1-sol"\nprofile = "fast"\n\n[profiles.fast]\nmodel_reasoning_effort = "low"\n[profiles.deep]\nmodel = "gpt-6-astra"\n',
    );
    expect(configuredCodexModel(path)).toBe("gpt-6.1-sol");
  });

  test("C-API-23 falls back to the root model when the selected profile is missing", () => {
    const path = tempCodexHome('profile = "gone"\nmodel = "gpt-6.1-sol"\n');
    expect(configuredCodexModel(path)).toBe("gpt-6.1-sol");
  });
});
