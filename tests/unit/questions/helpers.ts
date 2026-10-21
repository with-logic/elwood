/** Captured Claude frames and shared request fixtures (C-QUESTION-01/03). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
export const definitions: readonly QuestionDefinition[] = [
  {
    prompt: "Which test color?",
    header: "Color",
    options: [
      { label: "Amber", description: "Warm" },
      { label: "Blue", description: "Cool" },
    ],
    selection: "single",
    textMode: "alternative",
    secret: false,
  },
  {
    prompt: "Which test features?",
    header: "Features",
    options: [
      { label: "Logging", description: "Logs" },
      { label: "Metrics", description: "Counts" },
    ],
    selection: "multiple",
    textMode: "none",
    secret: false,
  },
];
export function registry() {
  return new QuestionRegistry("claude", "s", { emit: () => {} });
}
export function fixture(name: string): QuestionFrame {
  const text = readFileSync(
    fileURLToPath(new URL(`../../fixtures/claude-2.1.305/questions/${name}.txt`, import.meta.url)),
    "utf8",
  );
  return frame(text);
}
export function frame(text: string): QuestionFrame {
  const lines = text.split("\n");
  const cursorRow = lines.findLastIndex((line) => /^❯ /.test(line));
  return { text, lines, cursorRow, cursorY: cursorRow, cursorX: 0, rows: lines.length, cols: 140 };
}

export function nativeSnapshot(name: string): QuestionFrame {
  const snapshot = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../fixtures/claude-2.1.305/questions/${name}.json`, import.meta.url),
      ),
      "utf8",
    ),
  ) as QuestionFrame & { readonly baseY?: number; readonly viewportY?: number };
  return {
    ...snapshot,
    cursorRow:
      snapshot.cursorRow ?? snapshot.cursorY + (snapshot.baseY ?? 0) - (snapshot.viewportY ?? 0),
  };
}
