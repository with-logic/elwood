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

from runner_stub import STUB

class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(SOURCE, self.root / 'scripts/review', ignore=shutil.ignore_patterns('tests'))
        shutil.copy(SOURCE.parents[1] / 'opencode.json', self.root / 'opencode.json')
        for name in LENSES:
            skill = self.root / '.claude/skills' / name
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('Fixture lens')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.bin / 'opencode').write_text(STUB)
        (self.bin / 'opencode').chmod(0o755)
        (self.bin / 'rg').write_text('#!/bin/sh\nexit 0\n')
        (self.bin / 'rg').chmod(0o755)
        self.git('init', '-q')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'baseline')
        self.base = self.git('rev-parse', 'HEAD').strip()
        (self.root / 'fixture.txt').write_text('bounded fixture diff\n')
        self.git('add', 'fixture.txt')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '-qm', 'candidate')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True)

    def run_review(self, mode='clean', base=None, api_key='fixture-not-a-key'):
        env = {**os.environ, 'PATH': f'{self.bin}:{os.environ["PATH"]}',
               'OPENAI_API_KEY': api_key, 'REVIEW_TEST_ROOT': str(self.root),
               'REVIEW_TEST_MODE': mode, 'ELWOOD_REVIEW_LENS_ATTEMPTS': '2',
               'ELWOOD_REVIEW_PROCESS_TIMEOUT_SECONDS': '3' if mode.endswith('timeout') else '10', 'ELWOOD_REVIEW_DEADLINE_SECONDS': '30'}
        return subprocess.run(['bash', str(self.root / 'scripts/review/run.sh'), base or self.base],
                              env=env, capture_output=True, text=True, timeout=40)

    def test_all_eleven_lenses_run_before_clean_synthesis(self):
        (self.root / 'scripts/review/discussion.txt').write_text('TRUSTED_PR_CONTEXT')
        runtime = self.root / 'scripts/review/runtime.sh'
        with runtime.open('a') as stream:
            stream.write('\nkill_tree() { echo "$1" >> "$root/cleanup-pids"; }\n')
        result = self.run_review()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('discussion context supplied to all lenses and synthesis', result.stderr)
        self.assertFalse((self.root / 'cleanup-pids').exists())
        self.assertEqual(len(list(self.root.glob('call-review-*'))), 11)
        self.assertEqual((self.root / 'call-synthesis').read_text(), '1')
        self.assertIn('Verdict: clean, no notes', (self.root / 'REVIEW.md').read_text())

    def test_large_single_line_evidence_reaches_every_model_call_without_truncation(self):
        (self.root / 'fixture.txt').write_text('bounded fixture diff ' + 'D' * 60000 + 'DIFF_LAST_CANARY\n')
        self.git('add', 'fixture.txt')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '-qm', 'large bounded evidence')
        (self.root / 'scripts/review/discussion.txt').write_text(
            'TRUSTED_PR_CONTEXT ' + 'C' * 60000 + 'CONTEXT_LAST_CANARY')
        result = self.run_review('large-input')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('REPORT_LAST_CANARY', (self.root / 'REVIEW.md').read_text())
        self.assertEqual(len(list(self.root.glob('call-*'))), 12)

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
        self.assertNotIn('PRIVATE-REVIEW-TEXT', result.stderr)

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
        (self.root / 'REVIEW.md').write_text('STALE CLEAN REVIEW')
        result = self.run_review(base='does-not-exist')
        self.assertFalse((self.root / 'REVIEW.md').exists())
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
        self.assertIn('category=timeout exit=124', result.stderr)
        self.assertIn('was killed at its wall-clock cap', result.stderr)
        self.assertLess(time.monotonic() - started, 12)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'call-review-architecture-conventions').read_text(), '1', result.stderr)
        report = (self.root / 'REVIEW.md').read_text()
        self.assertIn('incomplete review coverage (blocker)', report)
        self.assertNotIn('Verdict: clean', report)
        time.sleep(4)
        self.assertFalse((self.root / 'orphan').exists())

    def test_sigkill_lens_is_not_retried_and_cannot_approve(self):
        result = self.run_review('killed')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'call-review-architecture-conventions').read_text(), '1', result.stderr)
        self.assertIn('category=killed exit=137', result.stderr)
        self.assertIn('incomplete review coverage (blocker)', (self.root / 'REVIEW.md').read_text())
        self.assertNotIn('Verdict: clean', (self.root / 'REVIEW.md').read_text())

    def test_findings_reach_synthesis_in_full(self):
        result = self.run_review('finding')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('discussion context unavailable', result.stderr)
        self.assertIn('#### major: Propagated finding', (self.root / 'REVIEW.md').read_text())

    def test_nonempty_malformed_lens_cannot_approve(self):
        result = self.run_review('malformed')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('incomplete review coverage', (self.root / 'REVIEW.md').read_text())
        self.assertIn('category=schema exit=1 elapsed_seconds=', result.stderr)

    def test_report_size_limits_never_silently_truncate_evidence(self):
        result = self.run_review('oversize')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('category=size', result.stderr)
        self.assertIn('incomplete review coverage', (self.root / 'REVIEW.md').read_text())
        (self.root / 'call-synthesis').unlink()
        result = self.run_review('aggregate')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('262144-byte synthesis budget', result.stderr)
        self.assertFalse((self.root / 'call-synthesis').exists())

    def test_missing_key_invalidates_stale_report_before_preflight(self):
        (self.root / 'REVIEW.md').write_text('STALE CLEAN REVIEW')
        result = self.run_review(api_key='')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'REVIEW.md').exists())
        self.assertFalse(list(self.root.glob('call-*')))

    def test_large_diff_fails_before_any_model_process(self):
        (self.root / 'fixture.txt').write_text('x' * 270000)
        self.git('add', 'fixture.txt')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '-qm', 'large diff')
        result = self.run_review()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('diff exceeds the 262144-byte input budget', result.stderr)
        self.assertFalse(list(self.root.glob('call-*')))

    def test_oversized_context_fails_before_any_model_process(self):
        (self.root / 'scripts/review/discussion.txt').write_text('C' * 65537)
        result = self.run_review()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('discussion exceeds the 65536-byte context budget', result.stderr)
        self.assertFalse(list(self.root.glob('call-*')))

    def test_synthesis_failure_has_bounded_phase_category_and_timing(self):
        for mode, category in [('synth-failed', 'process exit=2'), ('synth-killed', 'killed exit=137'), ('synth-timeout', 'timeout exit=124')]:
            result = self.run_review(mode)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(f'phase=synthesis category={category} elapsed_seconds=', result.stderr)
            self.assertNotIn('PRIVATE-SYNTHESIS-TEXT', result.stderr)

if __name__ == '__main__':
    unittest.main()
