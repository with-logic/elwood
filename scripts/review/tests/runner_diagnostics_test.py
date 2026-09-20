"""A failed retry assertion retains the original fake process error, within bounds (PRD §16)."""
from pathlib import Path
import tempfile
import unittest
import runner_test
from runner_diagnostics import assert_architecture_lens_one_attempt, attempt_diagnostics


class AttemptDiagnosticsTest(unittest.TestCase):
    def test_first_attempt_error_survives_later_timeout_and_assertion_failure(self):
        fixture = runner_test.RunnerTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        result = fixture.run_review('first-error-timeout')
        diagnostic = attempt_diagnostics(fixture.root)
        self.assertIn('category=process exit=1', result.stderr)
        self.assertIn('category=timeout exit=124', result.stderr)
        self.assertIn('attempt=1 exit=1', diagnostic)
        self.assertIn('FIRST_ATTEMPT_CANARY', diagnostic)
        self.assertNotIn('TRUNCATED_TAIL_CANARY', diagnostic)
        self.assertLessEqual(len(diagnostic), 4140)
        self.assertNotIn('FIRST_ATTEMPT_CANARY', result.stderr)
        for report in fixture.root.glob('capped-attempt.*.failure'):
            payload = report.read_bytes().split(b'\n', 1)[1]
            self.assertLessEqual(len(payload), 2048)
            self.assertNotIn(b'TRUNCATED_TAIL_CANARY', payload)
        with self.assertRaisesRegex(AssertionError, 'FIRST_ATTEMPT_CANARY'):
            assert_architecture_lens_one_attempt(self, fixture.root, result)

    def test_many_bounded_reports_exercise_the_aggregate_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(3):
                (root / f'capped-attempt.{index}.failure').write_text(f'attempt={index}\n' + 'x' * 2048)
            (root / 'capped-attempt.3.failure').write_text('AGGREGATE_TAIL_CANARY')
            diagnostic = attempt_diagnostics(root)
            self.assertIn('attempt=0', diagnostic)
            self.assertNotIn('AGGREGATE_TAIL_CANARY', diagnostic)
            self.assertEqual(len(diagnostic), len('\nFixture attempt diagnostics (bounded):\n') + 4096)

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
