# Codex 0.172.0 update offer, standalone install

Captured on 2026-11-25 from a copy-on-write clone of the user's standalone Codex 0.172.0
release, placed in a private `CODEX_HOME`'s `packages/standalone/releases/` so the
binary offers its own install action. `version.json` named `99.0.0` and
`check_for_update_on_startup = true`. Each capture is a fresh start at the named size,
rendered through Elwood's headless terminal 1.5 s after the offer's `Skip` row appeared,
with every application write dropped before the PTY. Trailing spaces were removed.

- `offer-standalone-100x30.txt`: the install command wraps once, onto a row indented
  five columns.
- `offer-standalone-60x30.txt`: `Release notes:` and its link take two rows, and the
  install command takes three.
- `offer-standalone-40x30.txt`: the link itself breaks mid-word across two rows, and the
  install command takes five.

## After the skip

Captured on 2026-11-25 the same way, at 100×30, through an Elwood session whose PTY
output was also fed to a separate headless terminal. Each file is that terminal's screen,
so it shows what Codex drew and not Elwood's rendering of it. Elwood's first `2` was
dropped before the PTY, and its second, 250 ms later, was forwarded. The project path was
replaced with `/tmp/elwood-update-CAPTURE` and trailing spaces were removed.

- `start-boot-partial.txt` is the first screen 8 ms after the `2`, on a fresh start: the
  header alone, with the cursor hidden.
- `start-boot-composer.txt` completed it in the same millisecond: the header, the logo,
  and the boot composer over `? for shortcuts`. The cursor was shown.
- `start-notice-partial.txt`, 0.8 s after the `2`: the boxed passive notice drawn above
  the header, with the composer still empty and the cursor hidden.
- `start-skipped-composer.txt` completed it: the configured composer, whose footer holds
  the model and project path.
- `resume-placeholder.txt` is the first screen 1 ms after the `2`, on `codex resume`:
  the same `Resuming session…` placeholder that the resume drew before its offer.
- `resume-notice-partial.txt` and `resume-skipped-composer.txt` followed 4.7 s after the
  `2`: the notice and the replayed turn, then the configured composer.

`../../codex-0.171.0/update/offer-npm-60x30.txt` is the npm 0.171.0 offer at 60 columns,
captured the same way. See `docs/cli-behavior.md`, "Codex 0.171.0 update offer".
