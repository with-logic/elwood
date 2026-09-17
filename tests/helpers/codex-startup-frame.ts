/** Native welcome chrome for focused Codex warning tests (C-CODEX-09, Codex 0.154.0). */
export function codexStartupFrame(body: string): string {
  return `╭────────────────────────────╮\n│ >_ OpenAI Codex (v0.154.0) │\n╰────────────────────────────╯\n${body}`.replace(
    /\r?\n/g,
    "\r\n",
  );
}
