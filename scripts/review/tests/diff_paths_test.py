"""Exercise environment-file diff rejection before any model process, including deletions."""
import unittest
import runner_test


class DiffPathsTest(unittest.TestCase):
    def test_added_deleted_and_renamed_environment_files_never_reach_models(self):
        for change in ['added', 'deleted', 'renamed']:
            with self.subTest(change=change):
                fixture = runner_test.RunnerTest()
                fixture.setUp()
                try:
                    path = fixture.root / '.env'
                    path.write_text('FAKE_CANARY=never-send\n')
                    fixture.git('add', '-f', '.env')
                    args = ('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                            '-c', 'commit.gpgsign=false', 'commit', '-qm', 'environment fixture')
                    fixture.git(*args)
                    if change != 'added':
                        fixture.base = fixture.git('rev-parse', 'HEAD').strip()
                        if change == 'deleted':
                            fixture.git('rm', '.env')
                        else:
                            fixture.git('mv', '.env', 'credentials.txt')
                        fixture.git(*args)
                    result = fixture.run_review()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('environment_file_changed', result.stderr)
                    self.assertNotIn('FAKE_CANARY', result.stderr)
                    self.assertFalse(list(fixture.root.glob('call-*')))
                finally:
                    fixture.doCleanups()
