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

## Folder-trust dialog (`folder-trust-*.txt`)

`folder-trust-no.txt` and `folder-trust-yes.txt` are the rendered folder-trust
gate of a fresh, untrusted directory, captured on 2026-10-25 through Elwood at
100x30 with `autotrust: false`. The first is the dialog as painted, with the
cursor on its default "No, exit"; the second follows a written `Home` + `Down`.
The workspace path is normalized to `/tmp/ELWOOD_CAPTURE/project` and trailing
blank rows are removed. The dialog was torn down without being answered.

## Working title (`working-half-right.txt`)

A turn's working frame captured on 2026-10-25 from Claude Code 2.1.310 with Opus 5.5, in
a 189-column session started by Elwood, while the OSC title read
`◑ Slow counting from one to twenty`. Sampling the title every 50 ms through that turn gave
`✳ ◐ ◑ ◐ ◑ ◐ ✳`: the working title alternates between `◐` and `◑`, and the idle title is
`✳`. The spinner row is `✢ Nebulizing… (2s)` with no `esc to interrupt`, which no frame in
the turn showed, so the title is the only working signal. The project path is normalized to
`/tmp/ELWOOD_CAPTURE/project`.

## Bypass-permissions acceptance dialog (`bypass-permissions-*.txt`)

The one-time `WARNING: Claude Code running in Bypass Permissions mode` dialog,
captured on 2026-10-26 from a session Elwood started with `--permission-mode
bypassPermissions` and autotrust, in an empty temporary project and a private
`CLAUDE_CONFIG_DIR` with no `settings.json` (the developer's own settings set
`skipDangerousModePermissionPrompt`, which hides the dialog). Autotrust had already
answered the folder-trust gate. `bypass-permissions-100.txt` is a 100x40 terminal,
where the sentences wrap, and `bypass-permissions-200.txt` a 200x40 one, where they
do not. The cursor starts on `No, exit`.

## Declined permission dialog (`permission-declined/`)

Captured on 2026-10-26 from Claude Code 2.1.310 with Opus 5.5, started by Elwood in
`default` permission mode with autotrust, in an empty temporary project, a 189x48
terminal, and a private `CLAUDE_CONFIG_DIR` with no `settings.json`. The session was
asked to create `elwood.txt` with its shell tool. `dialog.json` is the
`Do you want to proceed?` dialog, cursor hidden. `declined.json` is the frame about
6 s after a raw Escape declined it: the `⎿  Interrupted` banner, the idle composer
with its rules and footer, and a visible cursor at column 2. The submitted prompt
is still echoed as `❯ Create a file named …` above both. The project path is
normalized to `/tmp/ELWOOD_CAPTURE/project`.
