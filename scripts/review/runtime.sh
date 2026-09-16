#!/usr/bin/env bash
# Bounds the review processes, validates the diff base, and cleans up on cancellation. Implements PRD §16; see .github/PIPELINE.md.
# Sourced by run.sh; variables are shared with the other review helpers.
# shellcheck disable=SC2154,SC2034

positive_int_or_default() { # <value> <default> <name>
  local decimal
  decimal=$(printf '%s' "$1" | sed 's/^0*//')
  case "$decimal" in
    ''|*[!0-9]*) echo "review: $3 is not a positive integer; using $2" >&2; echo "$2" ;;
    *)
      if [ "${#decimal}" -gt 9 ]; then
        echo "review: $3 exceeds the supported integer range; using $2" >&2; echo "$2"
      else echo "$decimal"; fi ;;
  esac
}
process_timeout_seconds=$(positive_int_or_default "${ELWOOD_REVIEW_PROCESS_TIMEOUT_SECONDS:-900}" 900 ELWOOD_REVIEW_PROCESS_TIMEOUT_SECONDS)
deadline_seconds=$(positive_int_or_default "${ELWOOD_REVIEW_DEADLINE_SECONDS:-2400}" 2400 ELWOOD_REVIEW_DEADLINE_SECONDS)
lens_attempts=$(positive_int_or_default "${ELWOOD_REVIEW_LENS_ATTEMPTS:-3}" 3 ELWOOD_REVIEW_LENS_ATTEMPTS)
started_at=$(date +%s)
remaining_seconds() {
  local left=$(( deadline_seconds - ( $(date +%s) - started_at ) ))
  [ "$left" -lt 1 ] && left=1
  echo "$left"
}
base_revision="${1:-${ELWOOD_REVIEW_BASE:-origin/main}}"
if ! resolved_base_sha=$(git -C "$root" rev-parse --verify --quiet --end-of-options "$base_revision^{commit}"); then
  echo "review: base '$base_revision' does not resolve to a commit — fetch it or check the spelling" >&2
  exit 1
fi
base="$resolved_base_sha"
merge_base_status=0
merge_base_error=$(git -C "$root" merge-base HEAD "$base" 2>&1 >/dev/null) ||
  merge_base_status=$?
if [ "$merge_base_status" -eq 1 ]; then
  # Exit 1 is merge-base's specific "no common ancestor" answer.
  echo "review: base '$base_revision' shares no history with HEAD — is it from another repository?" >&2
  exit 1
elif [ "$merge_base_status" -ne 0 ]; then
  # Anything else is git failing for a reason of its own; its message is the
  # only thing that says what, so it is passed through rather than swallowed
  # behind a diagnosis that would be a guess.
  echo "review: could not compare base '$base_revision' with HEAD: ${merge_base_error:-git exited $merge_base_status}" >&2
  exit 1
fi
run_capped() {
  local cap="$process_timeout_seconds" remaining
  remaining=$(remaining_seconds)
  [ "$remaining" -lt "$cap" ] && cap="$remaining"
  python3 "$root/scripts/review/capped.py" "$cap" "$@"
}

out="$root/REVIEW.md"
tmp=$(mktemp -d)
tracked_pids=()
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}
cleanup() {
  trap - EXIT TERM INT
  local pid
  for pid in "${tracked_pids[@]:-}"; do
    [ -n "$pid" ] || continue
    kill_tree "$pid"
  done
  rm -rf "$tmp"
}
on_signal() { cleanup; exit 130; }
trap cleanup EXIT
trap on_signal TERM INT
