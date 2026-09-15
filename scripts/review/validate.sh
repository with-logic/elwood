#!/usr/bin/env bash
# Normalizes the report verdict and rejects ambiguous clean output. See .github/PIPELINE.md.
# Sourced by run.sh; variables are shared with the other review helpers.
# shellcheck disable=SC2154,SC2034

if [ ! -s "$tmp/REVIEW.md" ]; then
  echo "review: synthesis produced no output — not writing REVIEW.md" >&2
  exit 1
fi

if ! sed -i.bak -E 's/^[[:space:]]*\**[Vv][Ee][Rr][Dd][Ii][Cc][Tt]\**:\**[[:space:]]*/Verdict: /' "$tmp/REVIEW.md"; then
  echo "review: could not normalise the verdict line — not writing REVIEW.md" >&2
  exit 1
fi
rm -f "$tmp/REVIEW.md.bak"

if ! grep -qiE '^verdict:' "$tmp/REVIEW.md"; then
  echo "review: synthesis omitted the verdict line; inserting a non-approving one" >&2
  { echo "# Review"
    echo
    echo "Verdict: not ready - synthesis did not emit a machine-readable verdict"
    echo
    echo "---"
    echo
    sed -E '1{/^#+ *Review/d;}' "$tmp/REVIEW.md"
  } > "$tmp/REVIEW.fixed" && mv "$tmp/REVIEW.fixed" "$tmp/REVIEW.md"
fi

count_matches() {
  local n; n=$(grep -ciE "$1" "$tmp/REVIEW.md"); local code=$?
  if [ "$code" -gt 1 ]; then
    echo "review: cannot read the synthesized review — not writing REVIEW.md" >&2
    exit 1
  fi
  echo "${n:-0}"
}
clean_lines=$(count_matches '^verdict: *clean')
verdict_lines=$(count_matches '^verdict:')
if [ "$clean_lines" -gt 0 ] && [ "$verdict_lines" -ne 1 ]; then
  echo "review: clean verdict is ambiguous ($verdict_lines verdict lines) — not writing REVIEW.md" >&2
  exit 1
fi
