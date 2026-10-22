/** Native Codex working markers (PRD §5.3, C-TURN-01). */
export const codexWorkingTitle = /^[⠀-⣿]\s/;
// Native 0.163.0 pulses between • and ◦ while retaining its elapsed-time interrupt hint.
export const codexWorkingScreen =
  /^[•◦] [^\n]+ \((?:\d+s|\d+m \d{2}s|\d+h \d{2}m \d{2}s) • esc to interrupt\)(?: · [^\n]+)?$/im;
