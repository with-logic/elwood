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
import json, os, pathlib, re, subprocess, sys, time
root = pathlib.Path(os.environ['REVIEW_TEST_ROOT'])
prompt = sys.argv[sys.argv.index('--variant') + 2]
match = re.search(r'using the /(review-[a-z0-9-]+) skill', prompt)
name = match[1] if match else 'synthesis'
marker = root / ('call-' + name)
count = int(marker.read_text()) + 1 if marker.exists() else 1
marker.write_text(str(count))
mode = os.environ.get('REVIEW_TEST_MODE', 'clean')
assert '--auto' not in sys.argv
policy = json.loads(os.environ['OPENCODE_CONFIG_CONTENT'])['agent']['elwood-review']['permission']
assert policy['*'] == 'deny' and policy['bash'] == 'deny'
assert policy['read']['*.env'] == 'deny'

if match:
    attachment = pathlib.Path(sys.argv[sys.argv.index('-f') + 1])
    assert attachment.name == 'review.diff' and attachment.exists()
    assert '+bounded fixture diff' in attachment.read_text()
    assert 'static review only' in prompt
    if mode == 'all-failed' or (mode == 'missing' and name == 'review-architecture-conventions'):
        print('PRIVATE-REVIEW-TEXT', file=sys.stderr)
        sys.exit(1)
    if mode == 'timeout' and name == 'review-architecture-conventions':
        subprocess.Popen([sys.executable, '-c',
            'import pathlib,time; time.sleep(6); pathlib.Path(' + repr(str(root / 'orphan')) + ').touch()'])
        time.sleep(20)
    if mode == 'retry' and count == 1:
        sys.exit(1)
    if mode == 'malformed' and name == 'review-security':
        print('The lens stopped before finishing.')
    elif mode in ['finding', 'oversize', 'aggregate'] and (mode == 'aggregate' or name == 'review-security'):
        if mode in ['oversize', 'aggregate']: print('X' * (70000 if mode == 'oversize' else 30000))
        print('#### major: Propagated finding\n- Confidence: high\n- Location: fixture:1\n- Finding: It fails.\n- If unfixed: Failure persists.\n- Fix: Fix it.\n- Fix cost: One line.')
    else:
        print('No findings.')
    (root / ('done-' + name)).touch()
else:
    attachments = [pathlib.Path(sys.argv[i + 1]) for i, arg in enumerate(sys.argv) if arg == '-f']
    assert attachments
    if mode in ['clean', 'finding', 'retry']: assert len(attachments) == 11
    reports = {}
    for path in attachments:
        assert (root / ('done-' + path.stem)).exists(), 'Synthesis ran before lens finished'
        reports[path.stem] = path.read_text()
    print('# Review')
    if mode != 'no-verdict':
        print('Verdict: not ready - 0 blocker(s), 1 major(s), 0 minor(s), 0 nit(s)'
              if mode == 'finding' else 'Verdict: clean, no notes')
    print('\n## Findings By Dimension')
    for name, report in reports.items():
        print('\n### ' + name + '\n\n' + report)
    print('\n## Reviewer Coverage')
    for name in reports:
        print('- ' + name + ': completed')
'''


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
        (self.bin / 'rg').symlink_to('/usr/bin/true')
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

    def run_review(self, mode='clean', base=None):
        env = {**os.environ, 'PATH': f'{self.bin}:{os.environ["PATH"]}',
               'OPENAI_API_KEY': 'fixture-not-a-key', 'REVIEW_TEST_ROOT': str(self.root),
               'REVIEW_TEST_MODE': mode, 'ELWOOD_REVIEW_LENS_ATTEMPTS': '2',
               'ELWOOD_REVIEW_PROCESS_TIMEOUT_SECONDS': '3' if mode == 'timeout' else '10', 'ELWOOD_REVIEW_DEADLINE_SECONDS': '30'}
        return subprocess.run(['bash', str(self.root / 'scripts/review/run.sh'), base or self.base],
                              env=env, capture_output=True, text=True, timeout=40)

    def test_all_eleven_lenses_run_before_clean_synthesis(self):
        runtime = self.root / 'scripts/review/runtime.sh'
        with runtime.open('a') as stream:
            stream.write('\nkill_tree() { echo "$1" >> "$root/cleanup-pids"; }\n')
        result = self.run_review()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'cleanup-pids').exists())
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
        time.sleep(4)
        self.assertFalse((self.root / 'orphan').exists())

    def test_findings_reach_synthesis_in_their_attachments(self):
        result = self.run_review('finding')
        self.assertEqual(result.returncode, 0, result.stderr)
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


if __name__ == '__main__':
    unittest.main()
