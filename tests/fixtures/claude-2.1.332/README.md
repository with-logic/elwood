# Claude Code 2.1.332 auto-mode setup offer

These frames were captured on 2026-11-25 from sessions that Elwood started with
a `--name`, `--permission-mode auto`, Haiku 5.5, autotrust, and a 140x40
terminal. Each session ran in a private `CLAUDE_CONFIG_DIR` whose `.claude.json`
had `numStartups` of at least 5 and `autoModeEnvSetup` set to
`{ "denials": 5 }`. The project path is normalized to
`/tmp/ELWOOD_CAPTURE/project`.

- `auto-mode-offer.txt` is the offer as Claude painted it, about 70 ms after the
  `Stop` of the one turn sent (`Reply with exactly OK.`). It sits above the named
  composer, which stays visible. The hardware cursor is on the `❯ 1. Yes` row
  (column 2, row 31). Trailing blank rows are removed.
- `auto-mode-setup-step.txt` is the step that Enter on `1. Yes` opens. It
  replaces the composer. In this capture a human-equivalent Enter, sent with
  `sendKeys`, opened it. Before C-ATTN-09, the Enter of a caller's
  `sendMessage` opened it. Trailing blank rows are removed.
- `offer-closed-staged.json` is the first frame after Esc closed the offer over
  a 4-line `sendMessage` that was queued during the turn and pasted at `ready`.
  The paste is still staged as a `[Pasted text #1 +3 lines]` pill, with the
  visible hardware cursor after it (column 27, row 37). Trailing spaces are
  removed.

All three were closed with Esc and never continued.

## Working composer

`working-composer/` holds two frames captured on 2026-11-26 from one Elwood session
in bypass-permissions mode, Opus 5.5, autotrust and a 189x48 terminal, while Claude
ran `sleep 12` through its Bash tool. The project path is normalized to
`/tmp/ELWOOD_CAPTURE/project`, the usage notice above the composer is removed, and
trailing spaces are removed.

- `working-empty.json` is the composer during the tool call: `❯` and a no-break
  space over the `· esc to interrupt` footer, with the hardware cursor at column 2.
- `queued-messages.json` is the same composer 1.2 s after a `sendGuidance`, which
  Claude queued: it holds the `Press up to edit queued messages` placeholder, and
  the queued note shows above it.
