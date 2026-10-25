# Claude Code 2.1.310 named-session composer

`named-empty-input.json` is the idle composer of a session launched with
`--name "Question Asker"` (as Coal Harbor names every agent), captured on
2026-10-24 with Haiku 5.5, `default` permission mode, a 140x30 terminal and an
already-trusted project. The project path is normalized to
`/tmp/ELWOOD_CAPTURE/project`.

Claude insets the session name into the composer's top rule —
`──── Question Asker ─` — while the rule below the composer stays plain, and the
terminal title becomes `✳ Question Asker`.

## Permission-mode footers (`mode-footers/`)

Idle composers captured on 2026-10-25 from Claude Code 2.1.310 with Opus 5.5,
started by Elwood with `--permission-mode <mode>` in an empty temporary project.
No model prompt was sent. Each session started at 140x30, so the folder-trust
dialog fit and autotrust answered it. After ready it was resized to 100x8, which
pushes the version banner out of the viewport. Only the composer, its rules and
the footer remain. The project path is normalized to `/tmp/ELWOOD_CAPTURE/project`.

- `vim-*` use the developer's own settings: `editorMode: "vim"` (the
  `-- INSERT --` prefix) and `verbose: true` (the right-aligned `0 tokens`, with
  the effort level on the next row).
- `plain-*` override them through `--settings` with `editorMode: "normal"` and
  `verbose: false`. The effort level (`● high · /effort`) then sits at the
  right edge of the footer row.

`vim-manual`, `vim-auto` and `vim-dont-ask` were captured about 5 seconds
after launch and still show `· ← for agents`. `vim-bypass-permissions`,
`vim-accept-edits` and `vim-plan` were captured 27 seconds after launch, by
which point Claude had hidden the hint. The `plain-*` frames swap the two
groups, so each mode appears with and without the hint. A late `vim-*` frame
also has no effort row, and a late `plain-*` frame has nothing at the right
edge. A `default` launch renders the same `⏸ manual mode on` footer as `manual`.

`vim-bypass-permissions-after-model.json` is a 100x12 session after `/model` was
opened with raw keys and closed with Escape, twice. The banner has scrolled away
and `❯ /model` / `⎿ Kept model as Opus 5.5` remain above the composer.
