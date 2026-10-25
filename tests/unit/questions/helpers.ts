/** Captured Claude frames and shared request fixtures (PRD §4). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";

type ClaudeQuestionFixture = QuestionDefinition & { readonly header: string };
export const definitions: readonly ClaudeQuestionFixture[] = [
  {
    prompt: "Which test color?",
    header: "Color",
    options: [
      { label: "Amber", description: "Warm" },
      { label: "Blue", description: "Cool" },
    ],
    selection: "single",
    textMode: "alternative",
    supportsSecretInput: false,
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
    supportsSecretInput: false,
  },
];
export function registry() {
  return new QuestionRegistry("claude", "s", { emit: () => {} });
}
export function fixture(name: string, version = "2.1.305"): QuestionFrame {
  const text = readFileSync(
    fileURLToPath(
      new URL(`../../fixtures/claude-${version}/questions/${name}.txt`, import.meta.url),
    ),
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
  return parseNativeSnapshot(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(`../../fixtures/claude-2.1.305/questions/${name}.json`, import.meta.url),
        ),
        "utf8",
      ),
    ),
  );
}

export function parseNativeSnapshot(value: unknown): QuestionFrame {
  if (!isSnapshotRecord(value)) throw invalidSnapshot();
  const lines = snapshotLines(value["lines"]);
  const cursorVisible = value["cursorVisible"];
  if (cursorVisible !== undefined && typeof cursorVisible !== "boolean") throw invalidSnapshot();
  const cursorY = snapshotNumber(value["cursorY"]);
  const baseY = optionalSnapshotNumber(value["baseY"]);
  const viewportY = optionalSnapshotNumber(value["viewportY"]);
  const cursorRow = optionalSnapshotNumber(value["cursorRow"]);
  return {
    text: lines.join("\n"),
    lines,
    cols: snapshotNumber(value["cols"]),
    rows: snapshotNumber(value["rows"]),
    cursorX: snapshotNumber(value["cursorX"]),
    cursorY,
    cursorRow: cursorRow ?? cursorY + (baseY ?? 0) - (viewportY ?? 0),
    ...(cursorVisible === undefined ? {} : { cursorVisible }),
  };
}

function isSnapshotRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function snapshotNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw invalidSnapshot();
  return value;
}
function optionalSnapshotNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : snapshotNumber(value);
}
function snapshotLines(value: unknown): readonly string[] {
  if (!(Array.isArray(value) && value.every((line: unknown) => typeof line === "string")))
    throw invalidSnapshot();
  return value;
}
function invalidSnapshot(): Error {
  return new Error("Invalid native question snapshot");
}
