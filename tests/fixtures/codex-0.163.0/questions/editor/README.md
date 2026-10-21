# Native Codex editor provenance

Two isolated Codex 0.163.0 turns on 2026-10-21 captured queued free-text and
blocking modal notes editors. All prompts and values are synthetic. The probe
removed its private homes and verified that the parent configuration was unchanged.

The eight snapshots project the actual viewport and cursor from raw captures.
`cursorCellDimmed` is `Boolean(cell.isDim())` at the native cursor;
`cursorLineBefore` joins actual cell content before that column, respecting wide
cells. `capture.json` records hashes of the full source captures. The projection
omits unrelated cell attributes; it does not infer logical draft text or wrapping.

Empty and typed literal placeholders have identical rendered text. The empty
placeholder is dimmed with its cursor before the text; the literal is not dimmed
and leaves its cursor after the text. The native accepted values confirm the
literal `Type your answer` and `Add notes` answers.

Long input clips its beginning even in the 140×45 viewport. All captured xterm
`isWrapped` flags are false for both native manual wraps and actual newlines.
Interior trailing spaces lack visible glyphs but survive in the accepted value.
Both answer families trim outer whitespace when submitting: the 764-character
paste becomes its 760-character `trim()` result. The expected inputs and native
acceptance envelopes preserve that evidence.

A single viewport therefore cannot prove full logical equality of multirow or
clipped drafts. These parser regressions fail closed; the owned-paste and native
acceptance verification layer supplies the separate full-answer proof.
