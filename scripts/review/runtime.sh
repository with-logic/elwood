#!/usr/bin/env bash
# Bounds the review processes, validates the diff base, and cleans up on cancellation. See .github/PIPELINE.md.
# Sourced by run.sh; variables are shared with the other review helpers.
# shellcheck disable=SC2154,SC2034

require_positive_int() { # <value> <default> <name>
  case "$1" in
    ''|0|*[!0-9]*) echo "review: $3 is not a positive integer; using $2" >&2; echo "$2" ;;
    *) echo "$1" ;;
  esac
}
lens_timeout_seconds=$(require_positive_int "${ELWOOD_REVIEW_TIMEOUT:-900}" 900 ELWOOD_REVIEW_TIMEOUT)
deadline_seconds=$(require_positive_int "${ELWOOD_REVIEW_DEADLINE:-2400}" 2400 ELWOOD_REVIEW_DEADLINE)
lens_attempts=$(require_positive_int "${ELWOOD_REVIEW_ATTEMPTS:-3}" 3 ELWOOD_REVIEW_ATTEMPTS)
started_at=$(date +%s)
remaining_seconds() {
  local left=$(( deadline_seconds - ( $(date +%s) - started_at ) ))
  [ "$left" -lt 1 ] && left=1
  echo "$left"
}
base="${1:-${ELWOOD_REVIEW_BASE:-origin/main}}"
if ! resolved_base=$(git -C "$root" rev-parse --verify --quiet --end-of-options "$base^{commit}"); then
  echo "review: base '$base' does not resolve to a commit — fetch it or check the spelling" >&2
  exit 1
fi
base="$resolved_base"
merge_base_status=0
merge_base_error=$(git -C "$root" merge-base HEAD "$base" 2>&1 >/dev/null) ||
  merge_base_status=$?
if [ "$merge_base_status" -eq 1 ]; then
  # Exit 1 is merge-base's specific "no common ancestor" answer.
  echo "review: base '$base' shares no history with HEAD — is it from another repository?" >&2
  exit 1
elif [ "$merge_base_status" -ne 0 ]; then
  # Anything else is git failing for a reason of its own; its message is the
  # only thing that says what, so it is passed through rather than swallowed
  # behind a diagnosis that would be a guess.
  echo "review: could not compare base '$base' with HEAD: ${merge_base_error:-git exited $merge_base_status}" >&2
  exit 1
fi
if command -v timeout >/dev/null 2>&1; then
  timeout_command=timeout
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_command=gtimeout
fi
if [ -n "${timeout_command:-}" ]; then
  run_capped() {
    local c="$lens_timeout_seconds" r
    r=$(remaining_seconds)
    [ "$r" -lt "$c" ] && c="$r"
    "$timeout_command" --kill-after=30 "$c" "$@"
  }
else
  run_capped() {
    local c="$lens_timeout_seconds" r; r=$(remaining_seconds); [ "$r" -lt "$c" ] && c="$r"
    "$@" & local cmd=$!
    ( sleep "$c"; kill -9 "$cmd" 2>/dev/null ) & local watchdog=$!
    local code=0
    wait "$cmd" || code=$?
    # `|| true`: a watchdog that already fired makes kill exit nonzero, which
    # under `set -e` would fail a command that finished at the boundary.
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    return "$code"
  }
fi

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
