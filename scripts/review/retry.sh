#!/usr/bin/env bash
# Retries empty failed lens reports within the shared review deadline. See .github/PIPELINE.md.
# Sourced by run.sh; variables are shared with the other review helpers.
# shellcheck disable=SC2154,SC2034

run_lens() {
  local lens="$1" attempt=1 started code elapsed
  while :; do
    started=$(date +%s)
    # `code=$?` after an `if` would capture the `if`, not the command, so take
    # the status directly — it is the only thing that says why a lens died.
    code=0
    run_lens_once "$lens" || code=$?
    elapsed=$(( $(date +%s) - started ))
    # Success is a report, not an exit code: a lens that exits 0 having written
    # nothing produced no review, and the coverage check downstream would count
    # it as failed anyway. Treat it here, where we can still retry it.
    [ "$code" -eq 0 ] && [ -s "$tmp/$lens.md" ] && return 0

    # A lens the cap killed is never retried: 124 is the process-group wall-clock cap, 137 is SIGKILL. That lens did not hiccup, it ran out of clock, and a retry buys
    # another full cap for the same ending — three attempts would spend 45
    # minutes of a 40-minute deadline and starve synthesis. This is also the
    # bound that keeps a bad-credentials or provider-outage run cheap: those
    # fail in milliseconds, so three attempts cost three instants.
    case "$code" in
      124|137)
        # Report the elapsed time, not process_timeout_seconds: the effective cap
        # is the smaller of that and the remaining deadline, so naming the
        # configured value would point at the wrong number when the deadline
        # was what actually ran out.
        echo "review: $lens was killed at its wall-clock cap after ${elapsed}s (exit $code); not retrying" >&2
        return "$code" ;;
    esac

    # Wrote something but still failed: killed mid-report. The work happened
    # and is truncated, so a retry pays the same minutes to reach the same
    # place.
    if [ "$attempt" -ge "$lens_attempts" ] || [ -s "$tmp/$lens.md" ]; then
      return "$code"
    fi
    echo "review: $lens exited $code after ${elapsed}s with no report; retrying ($attempt/$((lens_attempts - 1)))" >&2
    attempt=$((attempt + 1))
  done
}
