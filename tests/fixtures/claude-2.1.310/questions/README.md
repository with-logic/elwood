# Native AskUserQuestion capture (Claude Code 2.1.310)

`single-question.txt` was captured on 2026-10-24 from Claude Code 2.1.310 with
Haiku 5.5, `bypassPermissions`, a 140x45 terminal and an empty temporary
project. The prompt and options are synthetic and the project path is
normalized to `/tmp/ELWOOD_QUESTION/project`.

2.1.310 renders the single-question header chip as ` ☐ Test pick ` — the
highlight's right padding is a real trailing space in the terminal row, where
2.1.305 rendered ` ☐ Note` with none. The rest of the panel matches the 2.1.305
captures in `../../claude-2.1.305/questions/`.

`named-single-question.txt` is the same request in a session launched with
`--name "Question Asker"` (as Coal Harbor names every agent), in `default`
permission mode from an already-trusted project. Claude draws the session name
into the prompt box's bottom border, which stays under the questionnaire footer:
`──── Question Asker ─`. The rule above the header chip stays plain.
