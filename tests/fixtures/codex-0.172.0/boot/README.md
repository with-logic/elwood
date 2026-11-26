# Codex 0.172.0 footer before and after session configuration

Captured on 2026-11-26 from Codex 0.172.0, launched by Elwood's `CodexSession` with
`model: "gpt-6-luna"` and `reasoningEffort: "low"` in a trusted folder with an isolated
`CODEX_HOME`, rendered through Elwood's headless terminal at 140 columns. Load average
was about 28. The sandbox path was replaced with `/tmp/elwood-boot-CAPTURE` and trailing
spaces were removed.

- `effort-default.txt` is the first frame whose status footer reads
  `GPT-6-Luna default`. Codex paints that footer once its model catalog loads, before
  it applies the session's configuration.
- `effort-low.txt` is the first frame after Codex applied it: the footer reads
  `GPT-6-Luna low`. Nothing else on the screen changed.

Applying the configuration resets Codex's collaboration mode, model and effort to the
session's, so a Plan mode or model chosen on the first frame is discarded. In 18
launches at load averages 7 to 50 the configuration landed 0.3 to 9.8 s after the
footer. In one, Elwood's 10-second readiness deadline fired 1.4 s before it, onto a
`default` footer. With a local proxy delaying each connection by 12 s, it landed 5.6 s
after the footer.
