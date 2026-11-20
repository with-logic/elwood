/** Strict config codec branch coverage. Covers PRD C-CLI-13/C-CLI-14. */

import { describe, expect, test } from "vitest";
import {
  decodeConfig,
  getConfigValue,
  parseConfigText,
  parseConfigValue,
  setConfigValue,
  unsetConfigValue,
} from "../../src/cli/config/codec.ts";
import { configKeys } from "../../src/cli/config/keys.ts";

describe("CLI config codec edges", () => {
  test("C-CLI-13 decodes every documented field", () => {
    const config = decodeConfig({
      schemaVersion: 1,
      agent: "codex",
      output: "jsonl",
      timeout: "2s",
      trust: true,
      stateDir: "state",
      verbose: false,
      stream: false,
      persona: "p",
      claude: { model: "c", reasoningEffort: "max", permissionMode: "auto" },
      codex: {
        model: "x",
        reasoningEffort: "minimal",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    expect(config).toMatchObject({ agent: "codex", claude: { model: "c" }, codex: { model: "x" } });
    expect(parseConfigText(JSON.stringify(config))).toEqual(config);
  });

  test.each([
    ["not json", /valid JSON/iu],
    ["null", /object/iu],
    ["[]", /object/iu],
    ["{}", /schemaVersion/iu],
    ['{"schemaVersion":1,"unknown":true}', /unknown/iu],
  ])("C-CLI-13 rejects malformed config %s", (text, message) => {
    expect(() => parseConfigText(text)).toThrow(message);
  });

  test.each([
    [{ schemaVersion: 1, agent: 1 }, /agent/iu],
    [{ schemaVersion: 1, output: "yaml" }, /output/iu],
    [{ schemaVersion: 1, timeout: "soon" }, /duration/iu],
    [{ schemaVersion: 1, trust: "yes" }, /true or false/iu],
    [{ schemaVersion: 1, stateDir: " " }, /non-empty/iu],
    [{ schemaVersion: 1, claude: null }, /object/iu],
    [{ schemaVersion: 1, codex: [] }, /object/iu],
    [{ schemaVersion: 1, claude: { extra: true } }, /extra/iu],
    [{ schemaVersion: 1, codex: { extra: true } }, /extra/iu],
    [{ schemaVersion: 1, claude: { reasoningEffort: "minimal" } }, /reasoningEffort/iu],
    [{ schemaVersion: 1, codex: { sandbox: "open" } }, /sandbox/iu],
  ])("C-CLI-13 rejects invalid shape %#", (value, message) => {
    expect(() => decodeConfig(value)).toThrow(message);
  });

  test("C-CLI-14 parses every dotted value family", () => {
    const values: Readonly<Record<string, string>> = {
      schemaVersion: "1",
      agent: "claude",
      output: "text",
      timeout: "1h",
      trust: "true",
      highTrust: "true",
      stateDir: "s",
      verbose: "false",
      stream: "true",
      persona: "p",
      "claude.model": "c",
      "claude.reasoningEffort": "low",
      "claude.permissionMode": "bypassPermissions",
      "codex.model": "x",
      "codex.reasoningEffort": "none",
      "codex.sandbox": "workspace-write",
      "codex.approvalPolicy": "untrusted",
    };
    for (const key of configKeys) expect(parseConfigValue(key, values[key]!)).toBeDefined();
    expect(() => parseConfigValue("unknown", "x")).toThrow(/unknown/iu);
    expect(() => parseConfigValue("schemaVersion", "2")).toThrow(/must be 1/iu);
    expect(() => parseConfigValue("stateDir", " ")).toThrow(/empty/iu);
  });

  test("C-CLI-14 gets, sets, and idempotently unsets top-level and dotted keys", () => {
    const base = { schemaVersion: 1, agent: "codex", claude: { model: "c" } } as const;
    expect(getConfigValue(base, "agent")).toBe("codex");
    expect(getConfigValue(base, "claude.model")).toBe("c");
    expect(getConfigValue(base, "codex.model")).toBeUndefined();
    expect(() => getConfigValue(base, "missing")).toThrow(/unknown/iu);
    expect(setConfigValue(base, "output", "json")).toMatchObject({ output: "json" });
    expect(setConfigValue(base, "codex.model", "x")).toMatchObject({ codex: { model: "x" } });
    expect(unsetConfigValue(base, "agent")).toEqual({ schemaVersion: 1, claude: { model: "c" } });
    expect(unsetConfigValue(base, "claude.model")).toEqual({ schemaVersion: 1, agent: "codex" });
    expect(unsetConfigValue(base, "codex.model")).toEqual(base);
    expect(unsetConfigValue(base, "schemaVersion")).toBe(base);
  });
});
