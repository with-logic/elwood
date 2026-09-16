#!/usr/bin/env python3
"""Bound one review process and its descendants; implements PRD §16; see .github/PIPELINE.md."""
import os
import signal
import subprocess
import sys


def stop_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def run(seconds, command):
    child = subprocess.Popen(command, start_new_session=True)
    try:
        return child.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        return 124
    finally:
        # The leader can exit before its children; clean the group in either case.
        stop_group(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        finally:
            # A signal during the grace-period wait must not skip the final kill/reap.
            stop_group(child.pid, signal.SIGKILL)
            child.wait()


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(run(int(sys.argv[1]), sys.argv[2:]))
