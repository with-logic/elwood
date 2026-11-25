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

`../../codex-0.171.0/update/offer-npm-60x30.txt` is the npm 0.171.0 offer at 60 columns,
captured the same way. See `docs/cli-behavior.md`, "Codex 0.171.0 update offer".
