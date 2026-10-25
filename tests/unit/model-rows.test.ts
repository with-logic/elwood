/**
 * Parser tests for rendered model picker rows.
 * Covers PRD §5.3 AgentModelOption parsing and C-API-23.
 */

import { describe, expect, test } from "vitest";
import { parseClaudeModelPicker, parseCodexModelPicker } from "../../src/core/models/rows.ts";
import {
  claudePicker,
  claudePickerCursorOnHaiku,
  codexPickerCurrentMarkerOnly,
  codexPickerSplitMarkers,
} from "../helpers/model-pickers.ts";

describe("model picker parsing", () => {
  test("C-API-23 parses the captured Claude picker", () => {
    const parsed = parseClaudeModelPicker(claudePicker);
    expect(parsed.options.map((option) => option.id)).toEqual([
      "default",
      "opus",
      "fable",
      "sonnet",
      "haiku",
    ]);
    expect(parsed.cursorOptionIndex).toBe(2);
    expect(parsed.options[0]).toMatchObject({ isDefault: true, isCurrent: false });
    expect(parsed.options[2]).toMatchObject({ label: "Fable", isCurrent: true, isDefault: false });
    expect(parsed.options[4]?.description).toBe("Haiku 4.5 · Fastest for quick answers");
    expect(parseClaudeModelPicker(claudePickerCursorOnHaiku).cursorOptionIndex).toBe(4);
  });

  test("C-API-23 parses Codex rows without inferring a default from `(current)`", () => {
    // Codex 0.164 marks only `(current)`; the Codex spec marks the default from config.toml.
    const parsed = parseCodexModelPicker(codexPickerCurrentMarkerOnly);
    expect(parsed.options.map((option) => option.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(parsed.cursorOptionIndex).toBe(0);
    expect(parsed.options[0]).toMatchObject({ isCurrent: true, isDefault: false });
    expect(parsed.options.filter((option) => option.isDefault)).toEqual([]);
  });

  test("C-API-23 keeps separate Codex current and default markers", () => {
    const parsed = parseCodexModelPicker(codexPickerSplitMarkers);
    expect(parsed.options[0]).toMatchObject({ id: "gpt-5.5", isDefault: true, isCurrent: false });
    expect(parsed.options[1]).toMatchObject({ id: "gpt-5.4", isCurrent: true, isDefault: false });
    expect(parsed.cursorOptionIndex).toBe(1);
  });

  test("C-API-23 returns no rows when the picker header is absent", () => {
    expect(parseClaudeModelPicker("❯ 1. Not a picker  row").options).toEqual([]);
    expect(parseCodexModelPicker("no header here").options).toEqual([]);
  });
});
