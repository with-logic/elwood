"""A failed retry assertion retains the original fake process error, within bounds (PRD §16)."""
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch
import runner_test
from runner_attempt_capture import MAX_ATTEMPT_STDERR_BYTES
from runner_diagnostics import (DIAGNOSTIC_PREFIX, MAX_DIAGNOSTIC_CHARS,
                                assert_architecture_lens_one_attempt, attempt_diagnostics)


class AttemptDiagnosticsTest(unittest.TestCase):
    def test_first_attempt_error_survives_later_timeout_and_assertion_failure(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        result = fixture.run_review('first-error-timeout')
        diagnostic = attempt_diagnostics(fixture.root)
        self.assertIn('category=process exit=1', result.stderr)
        self.assertIn('category=timeout exit=124', result.stderr)
        self.assertIn('lens=review-architecture-conventions attempt=1 exit=1', diagnostic)
        self.assertIn('FIRST_ATTEMPT_CANARY', diagnostic)
        self.assertNotIn('TRUNCATED_TAIL_CANARY', diagnostic)
        self.assertLessEqual(len(diagnostic), len(DIAGNOSTIC_PREFIX) + MAX_DIAGNOSTIC_CHARS)
        self.assertNotIn('FIRST_ATTEMPT_CANARY', result.stderr)
        for report in fixture.root.glob('capped-attempt.*.failure'):
            payload = report.read_bytes().split(b'\n', 1)[1]
            self.assertLessEqual(len(payload), MAX_ATTEMPT_STDERR_BYTES)
            self.assertNotIn(b'TRUNCATED_TAIL_CANARY', payload)
        with self.assertRaisesRegex(AssertionError, 'FIRST_ATTEMPT_CANARY'):
            assert_architecture_lens_one_attempt(self, fixture.root, result)

    def test_parser_failure_survives_the_later_timeout(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        result = fixture.run_review('first-parser-timeout')
        self.assertIn('category=transport exit=1', result.stderr)
        self.assertIn('category=timeout exit=124', result.stderr)
        self.assertNotIn('lens=synthesis', attempt_diagnostics(fixture.root))
        diagnostic = attempt_diagnostics(fixture.root)
        self.assertIn('lens=review-architecture-conventions attempt=1 exit=1', diagnostic)
        self.assertIn('review: invalid or incomplete model event stream', diagnostic)

    def test_synthesis_parser_failure_is_retained(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        result = fixture.run_review('synth-parser')
        self.assertIn('phase=synthesis category=transport', result.stderr)
        diagnostic = attempt_diagnostics(fixture.root)
        self.assertIn('lens=synthesis attempt=1 exit=1', diagnostic)
        self.assertIn('review: invalid or incomplete model event stream', diagnostic)

    def test_synthesis_validation_failure_is_retained_and_still_reported(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        (fixture.root / 'scripts/review/validate.sh').write_text('echo VALIDATION_CANARY >&2; exit 1\n')
        result = fixture.run_review()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.count('VALIDATION_CANARY'), 1)
        diagnostic = attempt_diagnostics(fixture.root)
        self.assertIn('lens=synthesis attempt=1 exit=1', diagnostic)
        self.assertIn('VALIDATION_CANARY', diagnostic)

    def test_oversized_validation_stderr_is_bounded_when_replayed(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        (fixture.root / 'scripts/review/validate.sh').write_text(
            "python3 -c 'import sys; sys.stderr.write(" + json.dumps('V' * 5000 + 'VALIDATION_TAIL') + ")'\nexit 1\n")
        result = fixture.run_review()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.count('V'), MAX_ATTEMPT_STDERR_BYTES)
        self.assertNotIn('VALIDATION_TAIL', result.stderr + attempt_diagnostics(fixture.root))

    def test_many_bounded_reports_exercise_the_aggregate_cap(self):
        self.assertEqual(MAX_ATTEMPT_STDERR_BYTES, 2048)
        self.assertEqual(MAX_DIAGNOSTIC_CHARS, 4096)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(3):
                (root / f'capped-attempt.{index}.failure').write_text(f'attempt={index}\n' + 'x' * MAX_ATTEMPT_STDERR_BYTES)
            (root / 'capped-attempt.3.failure').write_text('AGGREGATE_TAIL_CANARY')
            original_open = Path.open
            opened = []
            def tracked_open(path, *args, **kwargs):
                opened.append(path.name)
                return original_open(path, *args, **kwargs)
            with patch.object(Path, 'open', tracked_open):
                diagnostic = attempt_diagnostics(root)
            self.assertEqual(opened, ['capped-attempt.0.failure', 'capped-attempt.1.failure'])
            self.assertIn('attempt=0', diagnostic)
            self.assertNotIn('AGGREGATE_TAIL_CANARY', diagnostic)
            self.assertEqual(len(diagnostic), len(DIAGNOSTIC_PREFIX) + MAX_DIAGNOSTIC_CHARS)

    def test_successful_attempts_do_not_launch_the_capture_helper(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        (fixture.root / 'retain-attempt.py').write_text("raise RuntimeError('UNNECESSARY_CAPTURE')\n")
        result = fixture.run_review()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('UNNECESSARY_CAPTURE', result.stderr)

    def test_synthesis_failure_has_its_own_scope(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.run_review('synth-failed')
        reports = list(fixture.root.glob('capped-attempt.*.failure'))
        self.assertEqual(len(reports), 1)
        self.assertTrue(reports[0].read_text().startswith('lens=synthesis attempt=1 exit=2\n'))


if __name__ == '__main__':
    unittest.main()
