/** Bound update choices to one current dialog block (PRD §5.5, C-CODEX-12). */
import { type NumberedOption, numberedOptions } from "../../core/terminal-options.ts";

/** The first-party banner; its version pair distinguishes one appearance from the next. */
export const updateScreenBanner =
  /^[^\S\r\n]*(?:✨[^\S\r\n]*)?(?:Update available!\s+\d+\.\d+\.\d+\s*(?:->|→)\s*\d+\.\d+\.\d+|A new version of Codex is available[.!]?)[^\S\r\n]*$/im;

/** Unknown content after choices, or numbered scrollback before the banner, is ambiguous. */
export function updateDialogOptions(frame: string): readonly NumberedOption[] | undefined {
  const rows = frame.split("\n");
  const bannerRow = rows.findIndex((row) => updateScreenBanner.test(row));
  const banner = rows[bannerRow]?.trim();
  if (rows.some((row) => updateScreenBanner.test(row) && row.trim() !== banner)) return undefined;
  const before = bannerRow < 0 ? [] : rows.slice(0, bannerRow);
  if (before.some((row) => /(?:^|[\s›>])\d+[.)]/.test(row))) return undefined;
  return parseOptionBody(rows.slice(bannerRow + 1), bannerRow >= 0);
}

function parseOptionBody(body: readonly string[], hasBanner: boolean) {
  const optionRows: string[] = [];
  let footer = false;
  for (const row of body) {
    if (row.trim() === "") continue;
    if (/^\s*[›>]?\s*\d+[.)]\s*\S/.test(row)) {
      if (footer) return undefined;
      optionRows.push(row);
      continue;
    }
    if (optionRows.length > 0) {
      if (/^\s*Press enter to continue\s*$/i.test(row)) {
        footer = true;
        continue;
      }
      const previous = optionRows.at(-1) as string;
      if (!footer && wrappedUpdateAction(previous, row)) {
        optionRows[optionRows.length - 1] = `${previous} ${row.trim()}`;
        continue;
      }
      return undefined;
    }
    if (!(hasBanner && updateHeaderRow(row))) return undefined;
  }
  return orderedNativeOptions(numberedOptions(optionRows.join("\n")));
}

function orderedNativeOptions(options: readonly NumberedOption[]) {
  if (
    options.some(
      (option, index) =>
        !nativeOptionLabel(option.label) ||
        (index > 0 && Number(option.number) <= Number(options[index - 1]!.number)),
    )
  )
    return undefined;
  return options;
}

const nativeAction =
  "Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)";

function nativeOptionLabel(label: string): boolean {
  return (
    /^(?:Update now|Skip(?: until next version)?|Continue without updating|Not now|Later)$/i.test(
      label,
    ) ||
    label === "Update now (runs `npm install -g @openai/codex`)" ||
    (label.startsWith("Update now (runs `") && nativeAction.startsWith(label))
  );
}

function wrappedUpdateAction(previous: string, row: string): boolean {
  return /Update now \(runs `[^`]*$/.test(previous) && /^ {4,}\S/.test(row);
}

function updateHeaderRow(row: string): boolean {
  return (
    updateScreenBanner.test(row) ||
    /^\s*Release notes: https:\/\/github\.com\/openai\/codex\/releases\/latest\s*$/.test(row)
  );
}
