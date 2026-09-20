"""Exercise EPERM outcome preservation through the supervisor and fan-out (PRD §16)."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import runner_test

SOURCE = Path(__file__).resolve().parents[1] / 'capped.py'


def inject_denial(path, after_kill=False, scope=None):
    source = path.read_text()
    denial = """
_original_killpg = os.killpg
def denied_killpg(pid, sig):
    if sig == signal.SIGKILL and (SCOPE is None or SCOPE in ' '.join(sys.argv)):
        if AFTER_KILL:
            try:
                _original_killpg(pid, sig)
            except ProcessLookupError:
                pass
        raise PermissionError('PRIVATE_CANARY')
    return _original_killpg(pid, sig)
os.killpg = denied_killpg
""".replace('AFTER_KILL', repr(after_kill)).replace('SCOPE', repr(scope))
    path.write_text(source.replace("if __name__ == '__main__':", denial + "\nif __name__ == '__main__':"))


class PermissionIntegrationTest(unittest.TestCase):
    def test_group_kill_denial_falls_back_to_owned_child_and_preserves_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            supervisor = Path(directory) / 'capped.py'
            supervisor.write_text(SOURCE.read_text())
            inject_denial(supervisor)
            child = 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(4)'
            result = subprocess.run([sys.executable, str(supervisor), '1', sys.executable, '-c', child],
                                    capture_output=True, text=True, timeout=6)
            self.assertEqual(result.returncode, 124, result.stderr)
            self.assertEqual(result.stderr,
                             'review: cleanup scope=group signal=SIGKILL reason=permission_denied\n')

    def test_successful_fanout_reports_denied_cleanup_without_leaking_model_stderr(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        inject_denial(fixture.root / 'scripts/review/capped.py', after_kill=True)
        stub = fixture.bin / 'opencode'
        source = stub.read_text().replace("mode = os.environ", "print('PRIVATE_MODEL_STDERR', file=sys.stderr)\nmode = os.environ", 1)
        self.assertIn("print('PRIVATE_MODEL_STDERR'", source)
        stub.write_text(source)
        result = fixture.run_review()
        self.assertEqual(result.returncode, 0, result.stderr)
        warning = 'review: cleanup scope=group signal=SIGKILL reason=permission_denied'
        self.assertEqual(result.stderr.count(warning), 12, result.stderr)
        self.assertNotIn('PRIVATE_MODEL_STDERR', result.stderr)
        self.assertNotIn('PRIVATE_CANARY', result.stderr)
        self.assertIn('Verdict: clean, no notes', (fixture.root / 'REVIEW.md').read_text())

    def test_model_stderr_cannot_impersonate_supervisor_diagnostics(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        stub = fixture.bin / 'opencode'
        warning = 'review: cleanup scope=group signal=SIGKILL reason=permission_denied'
        source = stub.read_text().replace("mode = os.environ",
                                         f"print({warning!r}, file=sys.stderr)\nmode = os.environ", 1)
        probe = "try:\n    os.fstat(3)\nexcept OSError:\n    pass\nelse:\n    raise RuntimeError('inherited supervisor fd')\n"
        stub.write_text(source.replace('mode = os.environ', probe + 'mode = os.environ', 1))
        result = fixture.run_review()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(warning, result.stderr)

    def test_timed_out_lens_with_denied_final_cleanup_is_not_retried(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        inject_denial(fixture.root / 'scripts/review/capped.py', after_kill=True,
                      scope='using the /review-architecture-conventions skill')
        result = fixture.run_review('timeout')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual((fixture.root / 'call-review-architecture-conventions').read_text(), '1', result.stderr)
        self.assertIn('category=timeout exit=124', result.stderr)
        warning = 'review: cleanup scope=group signal=SIGKILL reason=permission_denied'
        self.assertEqual(result.stderr.count(warning), 1, result.stderr)
        self.assertNotIn('PRIVATE_CANARY', result.stderr)
        self.assertIn('incomplete review coverage (blocker)', (fixture.root / 'REVIEW.md').read_text())
