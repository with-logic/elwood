/**
 * The listing e2e's guard recognizes Claude 2.1.310's compiled fallback picker, as Elwood
 * parses it, and lets a served catalog through (C-API-23).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { rejectCompiledClaudeFallback } from "../e2e/claude-compiled-fallback.ts";

/** Claude 2.1.310's picker around `rows`, as captured with the catalog off on 2026-10-25. */
const listed = (rows: readonly string[]) =>
  claudeModelPicker.parse(
    [
      "  Select model",
      "  Switch between Claude models. Your pick becomes the default for new sessions.",
      "",
      ...rows,
      "",
      "  ● High effort ←/→ to adjust",
      "",
      "  Enter to set as default · s to use this session only · Esc to cancel",
    ].join("\n"),
  ).options;

test("C-API-23 the compiled fallback picker fails the listing e2e with its likely causes", () => {
  const fallback = listed([
    "    1. Default (recommended)  Opus 5.5 · Best for everyday, complex tasks",
    "  ❯ 2. Opus ✔                 Opus 5.5 · Best for everyday, complex tasks",
    "    3. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks",
    "    4. Sonnet                 Sonnet 5.5 · Efficient for routine tasks",
    "    5. Haiku                  Haiku 5.5 · Fastest for quick answers",
  ]);
  expect(() => rejectCompiledClaudeFallback(fallback)).toThrow(
    /compiled fallback picker \(Default, Opus, Fable, Sonnet, Haiku\).*CLAUDE_CODE_MODEL_CATALOG/,
  );
});

test("C-API-23 a served catalog passes the fallback guard unchanged", () => {
  const served = listed([
    "    1. Default (recommended)  Opus 5.5 · Best for everyday, complex tasks",
    "  ❯ 2. Opus 5.5 ✔             Best for everyday, complex tasks",
    "    3. Fable 5.1              Most capable for your hardest and longest-running tasks",
    "    4. Sonnet 5.5             Efficient for routine tasks",
    "    5. Haiku 5.5              Fastest for quick answers",
  ]);
  expect(served).toHaveLength(5);
  expect(rejectCompiledClaudeFallback(served)).toBe(served);
});
