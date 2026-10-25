# Claude Code 2.1.310 folder trust followed by a slow boot

`folder-trust-to-composer.json` is every PTY output chunk of one real fresh-folder
launch, from the first byte to the idle composer, with each chunk's offset in
milliseconds. It was captured on 2026-10-25 from Claude Code 2.1.310 (Opus 5.5,
Claude Max) started by Elwood (origin/main 62db80d7) with `autotrust: true` at
the default 189x48 size. Nine other launches ran at the same time, at a load
average of about 30–70. The project path is normalized to
`/tmp/ELWOOD_CAPTURE/project`; nothing else was changed.

The trust dialog paints at +44 ms. It is answered and erased at +910 ms (Claude
resets its selection to "No, exit" once on the way, at +680 ms). The screen then
stays blank, and from +5032 ms shows only the welcome banner. The composer paints
at +8976 ms. Live, origin/main reported `blocked` with `claude-workspace_trust-prompt`
attention at +5.0 s in this launch, while only the banner was on screen.
