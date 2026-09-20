#!/usr/bin/env python3
"""Bound a review process with best-effort descendant cleanup (PRD §16; .github/PIPELINE.md)."""
import os
import signal
import subprocess
import sys


CLEANUP_WAIT_SECONDS = 1
diagnostic_stream = None


def diagnose(message):
    try:
        print(message, file=diagnostic_stream if diagnostic_stream is not None else sys.stderr)
    except (OSError, ValueError):
        # A broken/closed log sink must not replace the outcome or skip cleanup.
        pass


def stop_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        diagnose(f'review: cleanup scope=group signal={sig.name} reason=permission_denied')
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
            child.wait(timeout=CLEANUP_WAIT_SECONDS)
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
                    diagnose('review: cleanup scope=child signal=SIGKILL reason=permission_denied')
            try:
                child.wait(timeout=CLEANUP_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                diagnose('review: cleanup scope=child reason=reap_timeout')


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    arguments = sys.argv[1:]
    if arguments[0] == '--diagnostics-fd=3':
        diagnostic_stream = os.fdopen(3, 'w', buffering=1, closefd=False)
        arguments = arguments[1:]
    # Popen's default close_fds keeps this supervisor channel out of model children.
    sys.exit(run(int(arguments[0]), arguments[1:]))
