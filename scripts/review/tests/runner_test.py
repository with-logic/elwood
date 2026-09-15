"""Exercise the real fan-out against Git fixtures and a deterministic CLI boundary."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parents[1]
LENSES = sorted(p.name for p in (SOURCE.parents[1] / '.claude/skills').glob('review-*'))

STUB = r'''#!/usr/bin/env python3
import os, pathlib, re, sys, time
root = pathlib.Path(os.environ['REVIEW_TEST_ROOT'])
prompt = sys.argv[sys.argv.index('--variant') + 2]
match = re.search(r'using the /(review-[a-z0-9-]+) skill', prompt)
name = match[1] if match else 'synthesis'
marker = root / ('call-' + name)
count = int(marker.read_text()) + 1 if marker.exists() else 1
marker.write_text(str(count))
mode = os.environ.get('REVIEW_TEST_MODE', 'clean')
if match:
    if mode == 'all-failed' or (mode == 'missing' and name == 'review-architecture-conventions'):
        sys.exit(1)
    if mode == 'timeout' and name == 'review-architecture-conventions':
        time.sleep(20)
    if mode == 'retry' and count == 1:
        sys.exit(1)
    print('No findings.')
else:
    print('# Review')
    if mode != 'no-verdict':
        print('Verdict: clean, no notes')
    print('\nAll lenses inspected the fixture.')
'''


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(SOURCE, self.root / 'scripts/review', ignore=shutil.ignore_patterns('tests'))
        for name in LENSES:
            skill = self.root / '.claude/skills' / name
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('Fixture lens')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.bin / 'opencode').write_text(STUB)
        (self.bin / 'opencode').chmod(0o755)
        (self.bin / 'rg').symlink_to('/usr/bin/true')
        self.git('init', '-q')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'baseline')
        self.base = self.git('rev-parse', 'HEAD').strip()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True)

    def run_review(self, mode='clean', base=None):
        env = {**os.environ, 'PATH': f'{self.bin}:{os.environ["PATH"]}',
               'OPENAI_API_KEY': 'fixture-not-a-key', 'REVIEW_TEST_ROOT': str(self.root),
               'REVIEW_TEST_MODE': mode, 'ELWOOD_REVIEW_ATTEMPTS': '2',
               'ELWOOD_REVIEW_TIMEOUT': '1' if mode == 'timeout' else '10', 'ELWOOD_REVIEW_DEADLINE': '30'}
        return subprocess.run(['bash', str(self.root / 'scripts/review/run.sh'), base or self.base],
                              env=env, capture_output=True, text=True, timeout=40)

    def test_all_eleven_lenses_run_before_clean_synthesis(self):
        result = self.run_review()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(list(self.root.glob('call-review-*'))), 11)
        self.assertEqual((self.root / 'call-synthesis').read_text(), '1')
        self.assertIn('Verdict: clean, no notes', (self.root / 'REVIEW.md').read_text())

    def test_missing_lens_cannot_approve_even_when_synthesis_says_clean(self):
        result = self.run_review('missing')
        self.assertNotEqual(result.returncode, 0)
        report = (self.root / 'REVIEW.md').read_text()
        self.assertIn('incomplete review coverage (blocker)', report)
        self.assertNotIn('Verdict: clean', report)

    def test_total_failure_emits_no_report(self):
        result = self.run_review('all-failed')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'REVIEW.md').exists())
        self.assertFalse((self.root / 'call-synthesis').exists())

    def test_empty_failure_is_retried(self):
        result = self.run_review('retry')
        self.assertEqual(result.returncode, 0, result.stderr)
        for marker in self.root.glob('call-review-*'):
            self.assertEqual(marker.read_text(), '2')

    def test_missing_verdict_is_non_approving(self):
        result = self.run_review('no-verdict')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Verdict: not ready', (self.root / 'REVIEW.md').read_text())

    def test_invalid_base_never_calls_the_model(self):
        result = self.run_review(base='does-not-exist')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not resolve', result.stderr)
        self.assertEqual(list(self.root.glob('call-*')), [])

    def test_missing_roster_entry_never_calls_the_model(self):
        shutil.rmtree(self.root / '.claude/skills/review-architecture-conventions')
        result = self.run_review()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.root.glob('call-*')), [])

    def test_wrong_named_lens_with_eleven_directories_never_calls_the_model(self):
        (self.root / '.claude/skills/review-security').rename(
            self.root / '.claude/skills/review-unrelated')
        result = self.run_review()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.root.glob('call-*')), [])

    def test_timed_out_lens_is_not_retried_and_cannot_approve(self):
        started = time.monotonic()
        result = self.run_review('timeout')
        self.assertLess(time.monotonic() - started, 12)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'call-review-architecture-conventions').read_text(), '1')
        report = (self.root / 'REVIEW.md').read_text()
        self.assertIn('incomplete review coverage (blocker)', report)
        self.assertNotIn('Verdict: clean', report)


if __name__ == '__main__':
    unittest.main()
