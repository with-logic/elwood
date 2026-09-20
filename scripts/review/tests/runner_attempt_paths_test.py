"""Retry outputs cannot share files with a surviving prior writer (PRD §16)."""
import json
import os
import signal
import unittest
import runner_test


SURVIVING_WRITER = r'''
import os, pathlib, sys, time
root = pathlib.Path(sys.argv[1])
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    if (root / 'second-attempt-started').exists():
        os.write(1, b'LATE_FIRST_STDOUT_CANARY\n')
        os.write(2, b'LATE_FIRST_ATTEMPT_CANARY\n')
        (root / 'late-write-complete').touch()
        break
    time.sleep(.01)
while time.monotonic() < deadline and not (root / 'writer-stop').exists():
    time.sleep(.01)
'''


class AttemptPathsTest(unittest.TestCase):
    def test_retry_outputs_isolated_from_a_surviving_prior_attempt_writer(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        stub = fixture.bin / 'opencode'
        marker = "mode = os.environ.get('REVIEW_TEST_MODE', 'clean')"
        probe = r'''
if mode == 'retry-stderr-paths' and name == 'review-architecture-conventions':
    identities = {}
    for fd in (1, 2):
        stat = os.fstat(fd)
        identities[fd] = [stat.st_dev, stat.st_ino]
    (root / f'output-identities-{count}').write_text(json.dumps(identities))
    if count == 1:
        child = subprocess.Popen([sys.executable, '-c', WRITER_SOURCE, str(root)],
                                 stdin=subprocess.DEVNULL,
                                 start_new_session=True)
        (root / 'writer-pid').write_text(str(child.pid))
        print('FIRST_ATTEMPT_CANARY', file=sys.stderr, flush=True)
    else:
        print('SECOND_ATTEMPT_CANARY', file=sys.stderr, flush=True)
        (root / 'second-attempt-started').touch()
        deadline = time.monotonic() + 5
        while not (root / 'late-write-complete').exists() and time.monotonic() < deadline:
            time.sleep(.01)
        assert (root / 'late-write-complete').exists(), 'Prior writer did not write during retry'
    sys.exit(1)
'''.replace('WRITER_SOURCE', repr(SURVIVING_WRITER))
        stub.write_text(stub.read_text().replace(marker, marker + probe, 1))
        try:
            result = fixture.run_review('retry-stderr-paths')
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((fixture.root / 'late-write-complete').exists(), result.stderr)
            identities = [json.loads((fixture.root / f'output-identities-{attempt}').read_text())
                          for attempt in (1, 2)]
            for fd in (1, 2):
                self.assertNotEqual(identities[0][str(fd)], identities[1][str(fd)],
                                    f'The retry reused the surviving writer\'s fd {fd} inode')
            reports = sorted(fixture.root.glob('capped-attempt.*.failure'))
            self.assertEqual(len(reports), 2)
            self.assertIn('FIRST_ATTEMPT_CANARY', reports[0].read_text())
            self.assertIn('SECOND_ATTEMPT_CANARY', reports[1].read_text())
            self.assertNotIn('LATE_FIRST_ATTEMPT_CANARY', reports[1].read_text())
        finally:
            (fixture.root / 'writer-stop').touch()
            pid = fixture.root / 'writer-pid'
            if pid.exists():
                try:
                    os.kill(int(pid.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == '__main__':
    unittest.main()
