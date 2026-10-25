/**
 * Unit tests for reading the Codex configured default model from a real config.toml.
 * Covers PRD §5.3 `isDefault` and C-API-23.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configuredCodexModel } from "../../src/codex/config/default-model.ts";

const original = process.env["CODEX_HOME"];

afterEach(() => {
  if (original === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = original;
});

function sandbox(contents?: string): void {
  const home = mkdtempSync(join(tmpdir(), "codex-default-"));
  process.env["CODEX_HOME"] = home;
  if (contents !== undefined) writeFileSync(join(home, "config.toml"), contents);
}

describe("Codex configured default model", () => {
  test("C-API-23 reads the root model key", () => {
    sandbox('model = "gpt-6.1-sol" # pinned\nmodel_reasoning_effort = "high"\n\n[hooks]\n');
    expect(configuredCodexModel()).toBe("gpt-6.1-sol");
  });

  test("C-API-23 reads a single-quoted root model", () => {
    sandbox("model = 'gpt-6-luna'\n");
    expect(configuredCodexModel()).toBe("gpt-6-luna");
  });

  test("C-API-23 ignores a model key that belongs to a table", () => {
    sandbox('model_reasoning_effort = "medium"\n\n[profiles.fast]\nmodel = "gpt-6-luna"\n');
    expect(configuredCodexModel()).toBeUndefined();
  });

  test("C-API-23 has no configured model without a config file", () => {
    sandbox();
    expect(configuredCodexModel()).toBeUndefined();
  });

  test.each([
    ["bare", "[profiles.fast]"],
    ["double-quoted", '[profiles."fast"]'],
    ["single-quoted", "[ profiles.'fast' ]"],
  ])("C-API-23 prefers the model of the root-selected %s profile", (_name, header) => {
    sandbox(
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
    sandbox(
      'model = "gpt-6.1-sol"\nprofile = "fast"\n\n[profiles.fast]\nmodel_reasoning_effort = "low"\n[profiles.deep]\nmodel = "gpt-6-astra"\n',
    );
    expect(configuredCodexModel()).toBe("gpt-6.1-sol");
  });

  test("C-API-23 falls back to the root model when the selected profile is missing", () => {
    sandbox('profile = "gone"\nmodel = "gpt-6.1-sol"\n');
    expect(configuredCodexModel()).toBe("gpt-6.1-sol");
  });
});
