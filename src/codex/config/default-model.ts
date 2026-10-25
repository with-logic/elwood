/**
 * Reads the Codex configured default model from config.toml, because Codex 0.164 marks
 * only the `(current)` row of its model picker and names no default on screen.
 * Implements PRD §5.3 `isDefault` and C-API-23.
 */

import { existsSync, readFileSync } from "node:fs";
import { codexConfigPath } from "./restore.ts";

const tableHeader = /^\s*\[/;
const profileTable = /^\s*\[\s*profiles\.(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*\]/;
const modelKey = /^\s*model\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const profileKey = /^\s*profile\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * The model a plain `codex` launch in this `CODEX_HOME` runs: the `model` of the profile
 * the root `profile` key selects, else the root `model` key. TOML requires root keys to
 * precede the first table header, so a `model` inside any other table is never read.
 * Undefined when the config names no model and Codex falls back to its built-in default.
 */
export function configuredCodexModel(): string | undefined {
  const path = codexConfigPath();
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n");
  const root = tableBody(lines, -1);
  const profile = stringValue(root, profileKey);
  const selected =
    profile === undefined ? -1 : lines.findIndex((line) => tableName(line) === profile);
  return (
    (selected < 0 ? undefined : stringValue(tableBody(lines, selected), modelKey)) ??
    stringValue(root, modelKey)
  );
}

/** The key lines after the header at `header` (-1 for the root) up to the next header. */
function tableBody(lines: readonly string[], header: number): readonly string[] {
  const rest = lines.slice(header + 1);
  const end = rest.findIndex((line) => tableHeader.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

function tableName(line: string): string | undefined {
  const match = profileTable.exec(line);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function stringValue(lines: readonly string[], key: RegExp): string | undefined {
  for (const line of lines) {
    const match = key.exec(line);
    if (match) return match[1] ?? match[2];
  }
  return undefined;
}
