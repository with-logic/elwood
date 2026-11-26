# Native AskUserQuestion captures (Claude Code 2.1.332)

Captured on 2026-11-25 from Claude Code 2.1.332 with Haiku 5.5, `default`
permission mode, a 140x45 terminal, a private configuration home and an empty,
already-trusted project. Each file is one complete terminal frame with its
native cursor; a visible cursor also records xterm's text before it as
`cursorLineBefore`. The prompt and options are synthetic and the project path is
normalized to `/tmp/ELWOOD_QUESTION/project`. The sessions were closed and
their private homes removed.

The frames show one single-choice question, `Which test note?`, asked after
Alt+T posted a notice at the idle composer. The notice's indent stays as blank
cells after `Type something.` on the questionnaire's last row.

- `single-other-notice-native.json`: `Detailed` highlighted, cursor hidden.
- `single-other-placeholder-native.json`: the cursor on the empty Other editor,
  before the dimmed `Type something.` placeholder.
- `single-other-typed-native.json`: `ELWOOD single line answer` pasted, with
  the cursor after it and the blank cells after the cursor.
- `single-other-two-lines-native.json`, from a second session:
  `ELWOOD_NOTE_LINE1_x` and `ELWOOD_NOTE_LINE2` pasted. The panel grew upward,
  so the second line sits on the notice row with the blank cells after it.

`PostToolUse` reported each pasted value as the `Which test note?` answer.

`standalone-checkbox-notice-native.json` was captured on 2026-11-24 the same
way. It is the first complete frame of one standalone checkbox question, which
Claude draws with a Submit tab: `←  ☐ Fruits  ✔ Submit  →`. The notice's
indent stays as blank cells after the `Submit` row. From the same session,
`standalone-checkbox-submit-native.json` has Apple and Cherry checked and
`Submit` highlighted, with the blank cells still there and the hidden cursor at
column zero of the last row, and `standalone-checkbox-review-native.json` is the
review with the cursor on `Submit answers`. `PostToolUse` reported
`Which test fruits?` = `Apple, Cherry`.

`named-standalone-checkbox-native.json` was captured on 2026-11-25 from a
session launched with `--name "Question Asker"`, after Alt+T posted the notice
at the idle composer. The questionnaire's closing rule replaced the notice row,
so no blank cells stay, and the label stays under the footer. `PostToolUse`
reported `Which test fruits?` = `Apple, Cherry`.

`single-other-wrapped-native.json`, `single-other-tabs-native.json` and
`single-other-unbroken-native.json` were captured on 2026-11-25 in separate
sessions without a notice, each after a paste into the Other editor: 70 words
that Claude wrapped at spaces onto three rows; `col1`, `col2` and `col3`
separated by tabs, which Claude drew as spaces; and `https://example.com/`
followed by 280 `a`s, which Claude broke inside the run.
`grouped-review-unbroken-native.json` is the review of a grouped
`Which test color?` and `Which test note?` questionnaire answered `Amber` and
that URL, which the review broke inside the run too. `PostToolUse` reported
each pasted value exactly.

`grouped-shrunk-footer-native.json` comes from a session with the notice: five
rows of Color text shrank the `Which test note?` panel by four rows, so its
footer landed on the notice row and kept the blank cells. Elwood's answer
stopped at this frame until it read such a footer.

See "Claude notice residue on the last questionnaire row" and "Claude question
editor: wrapping, tabs and line endings" in `docs/cli-behavior.md`.

The `narrow-*-native.json` frames were captured on 2026-11-25 the same way but
in a 60x45 terminal, with no notice posted and `EDITOR=nvim`. Each capture's
cursor is on the Other row, `Next` or `Submit`, where Claude adds
`ctrl+g to edit in Nvim` (it names the configured editor) and wraps the footer
over two rows. A grouped questionnaire's footer breaks after `ctrl+g to`,
leaving `edit in Nvim · Esc to cancel` on the last row; a single-question
footer leaves only `Esc to cancel` there.

- `narrow-grouped-next-native.json`: `Which test features?` with Logging and
  Metrics checked and `Next` highlighted, cursor hidden.
- `narrow-single-other-placeholder-native.json`: `Which test note?` with the
  cursor on the empty Other editor.
- `narrow-standalone-checkbox-submit-native.json`: `Which test fruits?` with
  Apple and Cherry checked and `Submit` highlighted, cursor hidden.
