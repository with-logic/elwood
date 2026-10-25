/**
 * Marks the Codex configured default model on listed picker rows, read from config.toml,
 * because Codex 0.164 marks only the `(current)` row and names no default on screen.
 * Implements PRD §5.3 `isDefault` and C-API-23.
 */

import { readFileSync } from "node:fs";
import { elwoodError, errnoCode } from "../../core/errors.ts";
import type { AgentModelOption } from "../../core/models/rows.ts";
import { withCodexConfigLock } from "./lock.ts";
import { codexConfigPath } from "./restore.ts";

const tableHeader = /^\s*\[/;
const profileTable = /^\s*\[\s*profiles\.(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*\]/;
const modelKey = /^\s*model\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const profileKey = /^\s*profile\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * Marks the configured default once per listing, under the process-wide config lock. A
 * concurrent `setModel` holds that lock while Codex's picker has written its selection
 * into config.toml, so the temporary selection is never read as the default. A deadline
 * or session close while waiting rejects without reading.
 */
export function withCodexDefault(
  options: readonly AgentModelOption[],
  signal: AbortSignal,
): Promise<readonly AgentModelOption[]> {
  return withCodexConfigLock(async () => markCodexDefault(options, configuredCodexModel()), {
    signal,
    error: () => signal.reason,
  });
}

/** A rendered `(default)` marker (older Codex) wins; otherwise the configured row is it. */
export function markCodexDefault(
  options: readonly AgentModelOption[],
  configuredModel: string | undefined,
): readonly AgentModelOption[] {
  if (options.some((option) => option.isDefault)) return options;
  const defaultId = configuredModel?.toLowerCase();
  return options.map((option) =>
    option.id === defaultId ? { ...option, isDefault: true } : option,
  );
}

/**
 * The model a plain `codex` launch in this `CODEX_HOME` runs: the `model` of the profile
 * the root `profile` key selects, else the root `model` key. TOML requires root keys to
 * precede the first table header, so a `model` inside any other table is never read.
 * Undefined when the config names no model and Codex falls back to its built-in default.
 */
export function configuredCodexModel(): string | undefined {
  const text = readConfig();
  if (text === undefined) return undefined;
  const lines = keyLines(text);
  const root = tableBody(lines, -1);
  const profile = stringValue(root, profileKey);
  const selected =
    profile === undefined
      ? -1
      : lines.findIndex((line) => profileNameFromTableHeader(line) === profile);
  return (
    (selected < 0 ? undefined : stringValue(tableBody(lines, selected), modelKey)) ??
    stringValue(root, modelKey)
  );
}

/** Only a missing file means "no config"; any other failure must not pass as one. */
function readConfig(): string | undefined {
  const path = codexConfigPath();
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return undefined;
    throw elwoodError(
      "model_automation_failed",
      "Could not read the Codex config to find its default model.",
      { path, code },
    );
  }
}

/**
 * The config's lines, with every line that starts inside a multiline string blanked: that
 * text is a value (an instruction quoting `model = "…"`, say), never a key or a header.
 */
function keyLines(text: string): readonly string[] {
  let open: string | undefined;
  return text.split("\n").map((line) => {
    const inValue = open !== undefined;
    open = openAtLineEnd(line, open);
    return inValue ? "" : line;
  });
}

/** The multiline-string delimiter still open after `line`, given the one open before it. */
function openAtLineEnd(line: string, openAtStart: string | undefined): string | undefined {
  let open = openAtStart;
  let at = 0;
  while (at < line.length) {
    if (open === undefined && line[at] === "#") return undefined;
    const delimiter = open ?? stringOpening(line, at);
    if (delimiter === undefined) {
      at += 1;
      continue;
    }
    const close = closingIndex(line, open === undefined ? at + delimiter.length : at, delimiter);
    // A single-line string cannot span lines; an unterminated one just ends this line.
    if (close < 0) return delimiter.length === 3 ? delimiter : undefined;
    open = undefined;
    at = close + delimiter.length;
  }
  return open;
}

/** The delimiter of a string opening at `at`, the multiline form before the plain quote. */
function stringOpening(line: string, at: number): string | undefined {
  const quote = line[at];
  if (quote !== '"' && quote !== "'") return undefined;
  return line.startsWith(quote.repeat(3), at) ? quote.repeat(3) : quote;
}

/** Where `delimiter` closes, from `from`; basic (`"`) strings skip backslash escapes. */
function closingIndex(line: string, from: number, delimiter: string): number {
  for (let at = from; at < line.length; at += 1) {
    if (delimiter.startsWith('"') && line[at] === "\\") at += 1;
    else if (line.startsWith(delimiter, at)) return at;
  }
  return -1;
}

/** The key lines after the header at `header` (-1 for the root) up to the next header. */
function tableBody(lines: readonly string[], header: number): readonly string[] {
  const rest = lines.slice(header + 1);
  const end = rest.findIndex((line) => tableHeader.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The `<name>` of a `[profiles.<name>]` header line, else undefined. */
function profileNameFromTableHeader(line: string): string | undefined {
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
