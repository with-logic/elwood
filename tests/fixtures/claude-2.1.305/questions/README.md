# Native AskUserQuestion captures

Captured from copied Claude Code 2.1.305, Haiku 5.5, a private configuration home
and an empty project on 2026-10-20. Prompts and answers are synthetic. Paths and
native identities are normalized. The capture sessions were killed and their
private authentication/configuration copies removed.

`hooks.json` pairs the grouped request with its native PostToolUse result:
Color = Blue; Features = Logging, Metrics. The screenshots preserve the single
selection, checkbox, per-question Submit, and final review stages. Space toggles
a checkbox; Enter on the final review's Submit answers accepts the entire batch.

`freeform-*` preserves a separate single-question request. Highlighting Type
something already focuses its editor. Bracketed paste followed by Enter accepted
`ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2` intact, as recorded in
`freeform-hooks.json`. Pressing Enter on an empty Type something row instead
produced User declined to answer questions in a separate exploratory capture.

These are native characterization fixtures, not evidence that the public Elwood
question API has passed. `tests/e2e/questions/claude-sandbox.ts` supplies an isolated
sandbox for the later API proof and checks parent configuration and keychain
fingerprints without exposing their contents.
