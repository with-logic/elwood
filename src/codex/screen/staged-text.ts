/** Codex recovery matches sanitized text only within the live idle composer (PRD §5.3). */
import { readStagedComposer } from "../../core/input/staged-composer.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { codexScreenFactTable } from "../screen-table.ts";
import { codexEmptyInputFrame, codexEmptyInputRows } from "./empty-input.ts";

export function codexTextStaged(terminal: ElwoodTerminal, payload: string): boolean {
  // Native tabs become one space; each CR/LF starts a separate composer row.
  const lastLine = payload
    .replaceAll("\t", " ")
    .trim()
    .split(/[\r\n]/)
    .at(-1)
    ?.trim();
  const draft = readStagedComposer(
    terminal,
    codexEmptyInputRows,
    codexScreenFactTable,
    "› Ask Codex to do anything",
  );
  return (
    lastLine !== undefined &&
    lastLine.length > 0 &&
    draft?.replace(/\s+/gu, " ").includes(lastLine.replace(/\s+/gu, " ")) === true
  );
}

export function createCodexRecoveryComposer(terminal: ElwoodTerminal) {
  return {
    staged: (_screen: string, payload: string) => codexTextStaged(terminal, payload),
    emptyFrame: () => codexEmptyInputFrame(terminal),
  };
}
