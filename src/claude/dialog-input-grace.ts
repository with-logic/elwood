/** Shared input settling time for Claude native dialogs (PRD §5.3, §5.10). */

// Claude Code can ignore or cancel input while a newly painted dialog's key handler settles.
export const claudeDialogInputGraceMs = 1_500;
