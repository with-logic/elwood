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
    tempCodexHome('model = "gpt-6.1-sol" # pinned\nmodel_reasoning_effort = "high"\n\n[hooks]\n');
    expect(configuredCodexModel()).toBe("gpt-6.1-sol");
  });

  test("C-API-23 reads a single-quoted root model", () => {
    tempCodexHome("model = 'gpt-6-luna'\n");
    expect(configuredCodexModel()).toBe("gpt-6-luna");
  });

  test("C-API-23 ignores a model key that belongs to a table", () => {
    tempCodexHome('model_reasoning_effort = "medium"\n\n[profiles.fast]\nmodel = "gpt-6-luna"\n');
    expect(configuredCodexModel()).toBeUndefined();
  });

  test("C-API-23 has no configured model without a config file", () => {
    tempCodexHome();
    expect(configuredCodexModel()).toBeUndefined();
  });

  test("C-API-23 a config that exists but cannot be read is an error, never 'no default'", () => {
    const path = tempCodexHome();
    mkdirSync(path); // config.toml is a directory: EISDIR
    expect(() => configuredCodexModel()).toThrow(
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
    tempCodexHome(
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
    expect(configuredCodexModel()).toBe("gpt-6-luna");
  });

  test("C-API-23 falls back to the root model when the selected profile sets none", () => {
    tempCodexHome(
      'model = "gpt-6.1-sol"\nprofile = "fast"\n\n[profiles.fast]\nmodel_reasoning_effort = "low"\n[profiles.deep]\nmodel = "gpt-6-astra"\n',
    );
    expect(configuredCodexModel()).toBe("gpt-6.1-sol");
  });

  test("C-API-23 falls back to the root model when the selected profile is missing", () => {
    tempCodexHome('profile = "gone"\nmodel = "gpt-6.1-sol"\n');
    expect(configuredCodexModel()).toBe("gpt-6.1-sol");
  });
});
