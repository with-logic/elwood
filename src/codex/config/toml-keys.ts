/**
 * Reads a string key from Codex config.toml text by the rule PRD §5.3 gives for the configured
 * default model (`isDefault`, C-API-23): the value in the profile the root `profile` key
 * selects, else the root value. It scans lines rather than parsing TOML. Text inside a
 * multiline string is never read as a key or a header, and a key's value is read from its
 * first line only, so a key set to a multiline string reads as `""`.
 */

const tableHeader = /^\s*\[/;
const profileTable = /^\s*\[\s*profiles\.(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*\]/;
const stringKey = /^\s*([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * The keys read through `configuredCodexString`. Add one only once the real CLI shows that
 * Codex resolves it by the same rule: profiles do not set every key, and Codex 0.172 reads a
 * profile from its own file instead (docs/cli-behavior.md).
 */
export type CodexConfigStringKey = "model";

/**
 * The string value of `key` for a plain launch with config text `configText`: the value in
 * the `[profiles.<name>]` table the root `profile` key names, else the root value. TOML
 * requires root keys to precede the first table header, so the key inside any other table is
 * never read. Undefined when neither sets it to a string.
 */
export function configuredCodexString(
  configText: string,
  key: CodexConfigStringKey,
): string | undefined {
  const lines = keyLines(configText);
  const root = tableBody(lines, -1);
  const profile = stringValue(root, "profile");
  const selected =
    profile === undefined
      ? -1
      : lines.findIndex((line) => profileNameFromTableHeader(line) === profile);
  return (
    (selected < 0 ? undefined : stringValue(tableBody(lines, selected), key)) ??
    stringValue(root, key)
  );
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

/** The string the first line setting the bare key `key` in `lines` opens with, else undefined. */
function stringValue(lines: readonly string[], key: string): string | undefined {
  for (const line of lines) {
    const match = stringKey.exec(line);
    if (match?.[1] === key) return match[2] ?? match[3];
  }
  return undefined;
}
