# Codex 0.171.0 update offer at start and on resume

Captured on 2026-11-24 from the installed npm Codex 0.171.0, run directly in a PTY
(100×30) with a private `CODEX_HOME` whose `version.json` named `0.172.0`, and rendered
through Elwood's headless terminal. Only terminal protocol replies were forwarded, apart
from the one `2` that skipped the offer. The project path was replaced with
`/tmp/elwood-update-CAPTURE` and trailing spaces were removed.

- `resume-placeholder.txt` is the first frame of `codex resume <id>`, 0.4 s after spawn:
  the header, `Resuming session…`, and a composer over `? for shortcuts`.
- `offer-npm.txt` replaced it 0.1 s later. The cursor was hidden. A fresh start drew the
  same rows.
- `resume-skipped-composer.txt` is the screen 1.3 s after `2` was written: Codex's boxed
  passive notice, the replayed turn, and the configured composer.
- `offer-npm-60x30.txt` was captured on 2026-11-25 from a fresh start at 60×30, with
  `version.json` naming `99.0.0` and every application write dropped. `Release notes:`
  and its link take two rows.

`../../codex-0.172.0/update/` holds the standalone 0.172.0 offer at 100, 60 and 40 columns.

See `docs/cli-behavior.md`, "Codex 0.171.0 update offer".
