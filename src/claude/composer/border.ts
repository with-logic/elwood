/**
 * Claude's prompt-box border in a named session (PRD §5.3, C-TRUST-01, C-QUESTION-03).
 *
 * `claude --name` (Elwood's `name` option) insets the session's label near the right end
 * of the prompt box's border: `──── Question Asker ─`. It sits on the composer's top rule
 * while the composer is shown, and on the border under a questionnaire's footer while a
 * dialog replaces the composer. The other rules stay plain.
 */

export const claudeNamedBorder = /^[─━]{3,} \S.* [─━]\s*$/;
