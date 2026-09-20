"""Diagnostic sink/storage errors must not skip real fixture cleanup (PRD §16)."""
import os
import json
from pathlib import Path
import signal
import shutil
import subprocess
import time
import unittest
import runner_test
from runner_attempt_capture import MAX_ATTEMPT_STDERR_BYTES


class DiagnosticCleanupTest(unittest.TestCase):
    def test_closed_stderr_setup_continues_and_preserves_exit_cleanup(self):
        for exit_code in (0, 7):
            with self.subTest(exit_code=exit_code):
                fixture = runner_test.RunnerTest()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                script = r'''
set -euo pipefail
root="$1"
mktemp() {
  local created
  created=$(command mktemp "$@")
  printf '%s' "$created" > "$root/owned-temp"
  printf '%s\n' "$created"
}
exec 2>&-
. "$root/scripts/review/runtime.sh" HEAD
printf continued > "$root/setup-continued"
echo validation > "$tmp/synth.validation.err"
exit "$2"
'''
                try:
                    result = subprocess.run(['bash', '-c', script, 'fixture', str(fixture.root), str(exit_code)],
                                            cwd=fixture.root, capture_output=True, text=True, timeout=5)
                    self.assertEqual((result.returncode,
                                      (fixture.root / 'setup-continued').exists(),
                                      Path((fixture.root / 'owned-temp').read_text()).exists()),
                                     (exit_code, True, False))
                finally:
                    marker = fixture.root / 'owned-temp'
                    if marker.exists():
                        shutil.rmtree(marker.read_text(), ignore_errors=True)

    def test_failed_diagnostics_preserve_exit_and_cleanup_owned_processes(self):
        for failure in ('sink', 'storage'):
            with self.subTest(failure=failure):
                fixture = runner_test.RunnerTest()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                capture = fixture.root / 'retain-attempt.py'
                body = capture.read_text() if failure == 'sink' else 'raise OSError("storage denied")\n'
                capture.write_text("import sys, json\nfrom pathlib import Path\n"
                                   "Path(sys.argv[1], 'capture-called').write_text(json.dumps(sys.argv[2:5]))\n" + body)
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
if [ "$2" = sink ]; then
  head() { printf '%s\n' "$@" > "$root/sink-called"; return 23; }
fi
exit 7
'''
                try:
                    result = subprocess.run(['bash', '-c', script, 'fixture', str(fixture.root), failure],
                                            cwd=fixture.root, capture_output=True, text=True, timeout=5)
                    pid = int((fixture.root / 'owned-pid').read_text())
                    self.assertEqual(result.returncode, 7, result.stderr)
                    self.assertEqual(json.loads((fixture.root / 'capture-called').read_text()),
                                     ['synthesis', '1', '124'])
                    reports = list(fixture.root.glob('capped-attempt.*.failure'))
                    if failure == 'sink':
                        self.assertEqual((fixture.root / 'sink-called').read_text().splitlines(),
                                         ['-c', str(MAX_ATTEMPT_STDERR_BYTES),
                                          (fixture.root / 'owned-temp').read_text() + '/synth.validation.err'])
                        self.assertEqual(len(reports), 1)
                        self.assertEqual(reports[0].read_text(), 'lens=synthesis attempt=1 exit=124\nvalidation\n')
                    else:
                        self.assertIn('OSError: storage denied', result.stderr)
                        self.assertEqual(reports, [])
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
