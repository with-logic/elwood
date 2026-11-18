/** Incomplete, ambiguous, and foreign native picker content never receives keys (C-API-24). */

import { expect, test } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../../src/codex/model-picker.ts";
import { parseModelViewport } from "../../../src/core/models/viewport/parse.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";

const top = capturedFrame("codex-0.169.0/model-picker/top");
const middle = capturedFrame("codex-0.169.0/model-picker/middle");
const collapsed = capturedFrame("claude-2.1.327/model-picker/collapsed");
const expanded = capturedFrame("claude-2.1.327/model-picker/expanded");
const compact = capturedFrame("claude-2.1.327/model-picker/compact-expanded");

test.each([
  ["above marker after rows", top.replace("\n↓\n", "\n↑\n"), codexModelPicker],
  ["below marker before rows", top.replace("\n› 1.", "\n↓\n› 1."), codexModelPicker],
  ["duplicate above markers", middle.replace("\n↑\n", "\n↑\n↑\n"), codexModelPicker],
  ["a row after a blank", top.replace("\n  2.", "\n\n  2."), codexModelPicker],
  ["two cursor rows", top.replace("\n  2.", "\n› 2."), codexModelPicker],
  ["unsafe row number", top.replace("› 1.", "› 9007199254740992."), codexModelPicker],
  ["zero row number", top.replace("› 1.", "› 0."), codexModelPicker],
  ["renumbered rows", top.replace("  2.", "  3."), codexModelPicker],
  ["first row without above marker", middle.replace("\n↑\n", "\n"), codexModelPicker],
  ["above marker at row one", top.replace("\n› 1.", "\n↑\n› 1."), codexModelPicker],
  ["reply before rows", top.replace("\n› 1.", "\n• A reply\n› 1."), codexModelPicker],
  [
    "duplicate disclosure",
    expanded.replace("▾   More models", "▾   More models\n    ▾ More models"),
    claudeModelPicker,
  ],
  [
    "missing effort control",
    collapsed.replace("  ◐ Medium effort (default)", ""),
    claudeModelPicker,
  ],
  [
    "unrecognized effort prose",
    collapsed.replace("Medium effort (default)", "Medium effort apparently"),
    claudeModelPicker,
  ],
  ["zero hidden count", compact.replace("↑ 5 more", "↑ 0 more"), claudeModelPicker],
  [
    "unrepresentable count",
    compact.replace("↑ 5 more", "↑ 9007199254740992 more"),
    claudeModelPicker,
  ],
  [
    "unrepresentable total",
    compact.replace("↑ 5 more", "↑ 9007199254740991 more"),
    claudeModelPicker,
  ],
  ["inconsistent item position", compact.replace("↑ 5 more", "↑ 6 more"), claudeModelPicker],
  [
    "mismatched disclosure hint",
    expanded.replace("Enter to collapse", "Enter to expand"),
    claudeModelPicker,
  ],
  ["foreign content after footer", `${expanded}\n❯ a human prompt`, claudeModelPicker],
  [
    "prose containing closing hint",
    collapsed.replace("Esc to cancel", "I mention Esc to cancel."),
    claudeModelPicker,
  ],
] as const)("C-API-24 rejects native picker with %s", (_name, text, spec) => {
  expect(spec.activeDialog(text, { opened: true })).toBeUndefined();
});

test("C-API-24 a wrapped native Max warning is recognized only verbatim", () => {
  const warning =
    "May use excessive tokens resulting in long response times or overthinking.\n" +
    "  Use sparingly for the hardest tasks.";
  const max = collapsed.replace("◐ Medium effort (default)", `◈ Max effort\n  ${warning}`);
  expect(claudeModelPicker.activeDialog(max, { opened: true })).toBe("picker");
  expect(
    claudeModelPicker.activeDialog(max.replace("Use sparingly", "Please use sparingly"), {
      opened: true,
    }),
  ).toBeUndefined();
});

test("C-API-24 a split control is sufficient for a modern catalog without a disclosure", () => {
  const withoutMore = collapsed.replace(/^.*More models.*\n/m, "");
  expect(parseModelViewport(withoutMore, "claude")?.options).toHaveLength(5);
});

test("C-API-24 unsupported-effort controls retain a navigable viewport", () => {
  const text = collapsed
    .replace(/^.*More models.*\n/m, "")
    .replace("◐ Medium effort (default)", "○ Effort not supported for Haiku 4.5");
  expect(parseModelViewport(text, "claude")?.options).toHaveLength(5);
});

test("C-API-24 model windows require at least two actual model rows", () => {
  const text =
    "Select model\n❯ 1. One  Description\n▸ More models\n\n◐ Medium effort\nEsc to cancel";
  expect(parseModelViewport(text, "claude")).toBeUndefined();
});
