/** Codex recovery matches sanitized text only within the live idle composer (PRD §5.3). */
import { readStagedComposer } from "../../core/input/staged-composer.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { codexScreenFactTable } from "../screen-table.ts";
import { codexEmptyInputFrame, codexEmptyInputRows } from "./empty-input.ts";

export function codexTextStaged(terminal: ElwoodTerminal, payload: string): boolean {
  return prepareCodexStaged(terminal, payload)();
}

function prepareCodexStaged(terminal: ElwoodTerminal, payload: string): () => boolean {
  let lastLine: string | undefined;
  return () => {
    const draft = readStagedComposer(
      terminal,
      codexEmptyInputRows,
      codexScreenFactTable,
      "› Ask Codex to do anything",
    );
    if (draft === undefined) return false;
    // Derive only after a live draft exists; retain only for this recovery sequence.
    lastLine ??= normalizedLastLine(payload);
    return lastLine.length > 0 && draft.replace(/\s+/gu, " ").includes(lastLine);
  };
}

function normalizedLastLine(payload: string): string {
  const trimmed = payload.trim();
  // CR/LF delimit native rows; tabs and other whitespace normalize only within the last row.
  const start = Math.max(trimmed.lastIndexOf("\r"), trimmed.lastIndexOf("\n")) + 1;
  return trimmed.slice(start).trim().replace(/\s+/gu, " ");
}

export function createCodexRecoveryComposer(terminal: ElwoodTerminal) {
  return {
    prepareStaged: (payload: string) => prepareCodexStaged(terminal, payload),
    emptyFrame: () => codexEmptyInputFrame(terminal),
  };
}
