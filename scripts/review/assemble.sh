#!/usr/bin/env bash
# Publishes REVIEW.md atomically, marking incomplete coverage as non-approving. See .github/PIPELINE.md.
# Sourced by run.sh; variables are shared with the other review helpers.
# shellcheck disable=SC2154,SC2034

final="$tmp/REVIEW.final.md"
: > "$final"
if [ -n "$incomplete" ]; then
  # Case-insensitive, matching the gate's `grep -qiE`: a synthesized
  # lowercase `verdict: clean` left intact would approve an incomplete review.
  # Must not be an `&&` chain: a failed sed there is silently swallowed and the
  # body's original "Verdict: clean" survives into an incomplete review.
  if ! sed -i.bak -E 's/^[Vv][Ee][Rr][Dd][Ii][Cc][Tt]:/Lens-only verdict (superseded):/' "$tmp/REVIEW.md"; then
    echo "review: could not demote the lens verdict — not writing REVIEW.md" >&2
    exit 1
  fi
  rm -f "$tmp/REVIEW.md.bak"
  # Belt and braces: if any verdict line survived the demotion, the artifact is
  # unsafe to post at all.
  if grep -qiE '^verdict:' "$tmp/REVIEW.md"; then
    echo "review: verdict line survived demotion — not writing REVIEW.md" >&2
    exit 1
  fi
  cat >> "$final" <<EOF

Verdict: not ready — incomplete review coverage (blocker)

- Confidence: high
- Location: the review run itself; see the job log for each lens's error
- Finding: no usable report from: ${incomplete}. The findings below come only from the
  lenses that ran, so absence of a finding in a missing dimension means nothing
  was looked for, not that nothing is there.
- If unfixed: the diff merges with one or more review dimensions never applied,
  and the verdict below understates what is unknown rather than what is clean.
- Fix: re-run the review; if a lens fails repeatedly, fix the lens before
  trusting a verdict from this diff.
- Fix cost: one re-run.

---

EOF
fi
cat "$tmp/REVIEW.md" >> "$final"
cp "$final" "$out.tmp"
mv "$out.tmp" "$out"
echo "review: wrote $out" >&2
[ -z "$incomplete" ] || exit 1
