"""Exercise decimal configuration and process-group termination at real OS boundaries."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[3]


class RuntimeTest(unittest.TestCase):
    def test_child_signal_status_uses_shell_encoding(self):
        for signum in (signal.SIGTERM, signal.SIGKILL):
            with self.subTest(signal=signum):
                child = f'import os; os.kill(os.getpid(), {int(signum)})'
                result = subprocess.run([sys.executable, str(ROOT / 'scripts/review/capped.py'),
                                         '10', sys.executable, '-c', child])
                self.assertEqual(result.returncode, 128 + signum)

    def test_zero_padded_positive_settings_are_decimal_and_zero_defaults(self):
        script = 'root="$PWD"; . scripts/review/runtime.sh HEAD; echo "$process_timeout_seconds $deadline_seconds $lens_attempts"'
        for value, expected in [('08', '8 8 8'), ('040', '40 40 40'), ('000', '900 2400 3')]:
            env = {**os.environ, **{key: value for key in [
                'ELWOOD_REVIEW_PROCESS_TIMEOUT_SECONDS', 'ELWOOD_REVIEW_DEADLINE_SECONDS',
                'ELWOOD_REVIEW_LENS_ATTEMPTS']}}
            result = subprocess.run(['bash', '-c', script], cwd=ROOT, env=env,
                                    capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.strip(), expected)

    def test_cancellation_terminates_a_descendant_even_if_it_ignores_term(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'escaped'
            ready = Path(directory) / 'ready'
            child = ('import pathlib,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); '
                     f'pathlib.Path({str(ready)!r}).write_text(str(__import__("os").getpid())); time.sleep(2); '
                     f'pathlib.Path({str(marker)!r}).touch()')
            leader = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{child!r}]); time.sleep(20)'
            process = subprocess.Popen([sys.executable, str(ROOT / 'scripts/review/capped.py'),
                                        '15', sys.executable, '-c', leader])
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(ready.exists())
                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=3), 143)
                child_pid = int(ready.read_text())
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    state = subprocess.run(['ps', '-p', str(child_pid), '-o', 'stat='],
                                           capture_output=True, text=True).stdout.strip()
                    if not state or state.startswith('Z'):
                        break
                    time.sleep(.02)
                self.assertTrue(not state or state.startswith('Z'), 'Descendant is still running')
                self.assertFalse(marker.exists())
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=3)


if __name__ == '__main__':
    unittest.main()
