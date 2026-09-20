"""A failed retry assertion retains the original fake process error, within bounds (PRD §16)."""
import unittest
import runner_test
from runner_diagnostics import assert_one_attempt, attempt_diagnostics


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
        with self.assertRaisesRegex(AssertionError, 'FIRST_ATTEMPT_CANARY'):
            assert_one_attempt(self, fixture.root, result)


if __name__ == '__main__':
    unittest.main()
