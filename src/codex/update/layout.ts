/** Bound update choices to one current dialog block (PRD §5.5, C-CODEX-12). */
import { type NumberedOption, numberedOptions } from "../../core/terminal-options.ts";

/**
 * Versioned and alternate native banners; a version pair, when present, identifies an
 * appearance. Codex 0.155 draws `Update available! X -> Y`, 0.171 `Update available · X → Y`.
 */
export const updateScreenBanner =
  /^[^\S\r\n]*(?:✨[^\S\r\n]*)?(?:Update available(?:!|[^\S\r\n]+·)\s+\d+\.\d+\.\d+\s*(?:->|→)\s*\d+\.\d+\.\d+|A new version of Codex is available[.!]?)[^\S\r\n]*$/im;

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
  let optionRows: readonly string[] = [];
  let footer = false;
  const notes = releaseNotesReader();
  for (const row of body) {
    if (row.trim() === "") continue;
    if (/^\s*[›>]?\s*\d+[.)]\s*\S/.test(row)) {
      if (footer || !notes.complete()) return undefined;
      optionRows = [...optionRows, row];
      continue;
    }
    if (optionRows.length > 0) {
      const folded = foldAfterChoices(optionRows, row, footer);
      if (folded === undefined) return undefined;
      ({ rows: optionRows, footer } = folded);
      continue;
    }
    if (!(hasBanner && notes.accept(row))) return undefined;
  }
  return orderedNativeOptions(numberedOptions(optionRows.join("\n")));
}

/** Folds one row after the choices into them: the footer, or the wrapped action's next row. */
function foldAfterChoices(rows: readonly string[], row: string, footer: boolean) {
  if (/^\s*(?:Press enter to continue|enter continue · esc skip)\s*$/i.test(row))
    return { rows, footer: true };
  const previous = rows.at(-1) as string;
  if (footer || !wrappedUpdateAction(previous, row)) return undefined;
  return { rows: [...rows.slice(0, -1), `${previous} ${row.trim()}`], footer };
}

const releaseNotes = compact("Release notes: https://github.com/openai/codex/releases/latest");

/** The rows above the choices: repeated banners, then release notes that may wrap. */
function releaseNotesReader() {
  let read = "";
  return {
    accept(row: string): boolean {
      if (updateScreenBanner.test(row)) return true;
      read += compact(row);
      return releaseNotes.startsWith(read);
    },
    /** No release notes, or all of them. */
    complete: () => read === "" || read === releaseNotes,
  };
}

/** A terminal wraps at spaces or mid-word, so wrapped native text is compared without whitespace. */
function compact(text: string): string {
  return text.replace(/\s+/g, "");
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

/** The install commands Codex's update action names: npm, then standalone 0.155 and 0.172. */
const nativeActions = [
  "Update now (runs `npm install -g @openai/codex`)",
  "Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)",
  "Update now (runs `sh -c 's=$(curl -fsSL https://chatgpt.com/codex/install.sh) && CODEX_NON_INTERACTIVE=1 eval \"$s\"'`)",
].map(compact);

/** A clipped screen can cut an action's command short; its visible part must still match. */
function nativeOptionLabel(label: string): boolean {
  return (
    /^(?:Update now|Skip(?: until next version)?|Continue without updating|Not now|Later)$/i.test(
      label,
    ) ||
    (label.startsWith("Update now (runs `") &&
      nativeActions.some((action) => action.startsWith(compact(label))))
  );
}

function wrappedUpdateAction(previous: string, row: string): boolean {
  return /Update now \(runs `[^`]*$/.test(previous) && /^ {4,}\S/.test(row);
}
