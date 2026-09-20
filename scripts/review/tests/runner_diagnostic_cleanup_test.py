"""Diagnostic sink/storage errors must not skip real fixture cleanup (PRD §16)."""
import os
from pathlib import Path
import signal
import shutil
import subprocess
import time
import unittest
import runner_test


class DiagnosticCleanupTest(unittest.TestCase):
    def test_failed_diagnostics_preserve_exit_and_cleanup_owned_processes(self):
        for failure in ('sink', 'storage'):
            with self.subTest(failure=failure):
                fixture = runner_test.RunnerTest()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                if failure == 'storage':
                    (fixture.root / 'retain-attempt.py').write_text('raise OSError("storage denied")\n')
                script = r'''
set -euo pipefail
root="$1"
. "$root/scripts/review/runtime.sh" HEAD
printf '%s' "$tmp" > "$root/owned-temp"
sleep 30 >/dev/null 2>&1 4>&- &
tracked_pids=("$!")
printf '%s' "$!" > "$root/owned-pid"
synthesis_active=true
synth_code=124
: > "$tmp/synth.err"
echo validation > "$tmp/synth.validation.err"
if [ "$2" = sink ]; then exec 4>&-; fi
exit 7
'''
                try:
                    result = subprocess.run(['bash', '-c', script, 'fixture', str(fixture.root), failure],
                                            cwd=fixture.root, capture_output=True, text=True, timeout=5)
                    pid = int((fixture.root / 'owned-pid').read_text())
                    self.assertEqual(result.returncode, 7, result.stderr)
                    self.assertFalse(Path((fixture.root / 'owned-temp').read_text()).exists())
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='],
                                               capture_output=True, text=True).stdout.strip()
                        if not state or state.startswith('Z'):
                            break
                        time.sleep(.02)
                    self.assertTrue(not state or state.startswith('Z'), 'Owned child survived cleanup')
                finally:
                    try:
                        os.kill(int((fixture.root / "owned-pid").read_text()), signal.SIGKILL)
                    except (ProcessLookupError, FileNotFoundError):
                        pass
                    marker = fixture.root / "owned-temp"
                    if marker.exists():
                        shutil.rmtree(marker.read_text(), ignore_errors=True)
