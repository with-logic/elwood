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
    except PermissionError:
        print(f'review: cleanup scope=group signal={sig.name} reason=permission_denied', file=sys.stderr)
        return False
    return True


def run(seconds, command):
    child = subprocess.Popen(command, start_new_session=True)
    try:
        code = child.wait(timeout=seconds)
        # Popen encodes signals as negatives; the shell retry policy expects 128+signal.
        return 128 - code if code < 0 else code
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
            if not stop_group(child.pid, signal.SIGKILL):
                # We still own the direct child even when the group cannot be signalled.
                try:
                    child.kill()
                except ProcessLookupError:
                    pass
                except PermissionError:
                    print('review: cleanup scope=child signal=SIGKILL reason=permission_denied', file=sys.stderr)
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                print('review: cleanup scope=child reason=reap_timeout', file=sys.stderr)


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(run(int(sys.argv[1]), sys.argv[2:]))
