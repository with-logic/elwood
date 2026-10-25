/**
 * Parser tests for rendered model picker rows.
 * Covers PRD §5.3 AgentModelOption parsing and C-API-23.
 */

import { describe, expect, test } from "vitest";
import { parseClaudeModelPicker, parseCodexModelPicker } from "../../src/core/models/rows.ts";
import {
  claudePicker,
  claudePickerCursorOnHaiku,
  codexPickerCurrentIsDefault,
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
    expect(parsed.cursorIndex).toBe(2);
    expect(parsed.options[0]).toMatchObject({ isDefault: true, isCurrent: false });
    expect(parsed.options[2]).toMatchObject({ label: "Fable", isCurrent: true, isDefault: false });
    expect(parsed.options[4]?.description).toBe("Haiku 4.5 · Fastest for quick answers");
    expect(parseClaudeModelPicker(claudePickerCursorOnHaiku).cursorIndex).toBe(4);
  });

  test("C-API-23 marks the configured Codex model when only a current marker renders", () => {
    const parsed = parseCodexModelPicker(codexPickerCurrentIsDefault, "GPT-5.4");
    expect(parsed.options.map((option) => option.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(parsed.cursorIndex).toBe(0);
    expect(parsed.options[0]).toMatchObject({ isCurrent: true, isDefault: false });
    expect(parsed.options[1]).toMatchObject({ isCurrent: false, isDefault: true });
  });

  test("C-API-23 never infers the Codex default from the current marker", () => {
    // Codex 0.164 marks only `(current)`, which a session switch moves off the default.
    for (const configured of [undefined, "gpt-6-unlisted"]) {
      const parsed = parseCodexModelPicker(codexPickerCurrentIsDefault, configured);
      expect(parsed.options.filter((option) => option.isDefault)).toEqual([]);
    }
  });

  test("C-API-23 keeps separate Codex current and default markers", () => {
    const parsed = parseCodexModelPicker(codexPickerSplitMarkers, "gpt-5.4-mini");
    expect(parsed.options[0]).toMatchObject({ id: "gpt-5.5", isDefault: true, isCurrent: false });
    expect(parsed.options[1]).toMatchObject({ id: "gpt-5.4", isCurrent: true, isDefault: false });
    expect(parsed.cursorIndex).toBe(1);
  });

  test("C-API-23 returns no rows when the picker header is absent", () => {
    expect(parseClaudeModelPicker("❯ 1. Not a picker  row").options).toEqual([]);
    expect(parseCodexModelPicker("no header here").options).toEqual([]);
  });
});
