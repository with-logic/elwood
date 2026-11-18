/**
 * Parser tests for rendered model picker rows.
 * Covers PRD §5.3 AgentModelOption parsing and C-API-23.
 */

import { describe, expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { parseClaudeModelPicker } from "../../src/claude/models/parse.ts";
import { parseCodexModelPicker } from "../../src/core/models/rows.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import {
  claudePicker,
  claudePickerCursorOnHaiku,
  codexPickerCurrentMarkerOnly,
  codexPickerSplitMarkers,
} from "../helpers/model-pickers.ts";

describe("model picker parsing", () => {
  test("C-API-23 known context decorations become native context selectors", () => {
    const labels = [
      "Opus (1M context)",
      "Fable 5.2 (1M context)",
      "Default (1M context)",
      "Project Model (1M context)",
    ];
    const models = parseClaudeModelPicker(
      ["Select model", ...labels.map((label, i) => ` ${i + 1}. ${label}  Description`)].join("\n"),
    ).options;
    expect(models.map((model) => model.id)).toEqual([
      "opus[1m]",
      "claude-fable-5-2[1m]",
      null,
      null,
    ]);
    expect(models.map((model) => model.label)).toEqual(labels);
  });

  test("C-API-23 captured Claude versioned labels have native launch selectors", () => {
    const models = claudeModelPicker.parse(
      capturedFrame("claude-2.1.327/model-picker/expanded"),
    ).options;
    expect(models.find((model) => model.label === "Haiku 5.5")).toMatchObject({
      id: "claude-haiku-5-5",
      label: "Haiku 5.5",
    });
    expect(models.find((model) => model.label === "Opus 5.5")?.id).toBe("claude-opus-5-5");
    expect(models.find((model) => model.label === "Sonnet 5")?.id).toBe("claude-sonnet-5");
    expect(models.find((model) => model.label === "Default")?.id).toBe("default");
  });

  test("C-API-23 keeps explicit selectors and marks unrecognized Claude labels unavailable", () => {
    const labels = [
      "claude-haiku-4-5-20251001",
      "claude-fable-5-2[1m]",
      "Project Model",
      "Future 6.0",
    ];
    const parsed = parseClaudeModelPicker(
      [
        "Select model",
        ...labels.map(
          (label, i) => ` ${i + 1}. ${label}${i === 2 ? " ✔ (recommended)" : ""}  Description`,
        ),
      ].join("\n"),
    );
    expect(parsed.options.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: labels[0], label: labels[0] },
      { id: labels[1], label: labels[1] },
      { id: null, label: labels[2] },
      { id: null, label: labels[3] },
    ]);
    expect(parsed.options[2]).toEqual({
      id: null,
      label: "Project Model",
      description: "Description",
      raw: "3. Project Model ✔ (recommended)  Description",
      isCurrent: true,
      isDefault: true,
    });
  });

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
