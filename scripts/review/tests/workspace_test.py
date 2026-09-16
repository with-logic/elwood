"""Exercise the real filesystem boundary behind the review's file-read policy."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'workspace.py'
SPEC = importlib.util.spec_from_file_location('review_workspace', SCRIPT)
WORKSPACE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKSPACE)


class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        self.root = self.parent / 'checkout'
        self.root.mkdir()

    def test_regular_files_and_internal_contributor_guide_link_are_allowed(self):
        (self.root / 'CLAUDE.md').write_text('Contributor instructions')
        (self.root / 'AGENTS.md').symlink_to('CLAUDE.md')
        (self.root / '.env.example').write_text('NON_SECRET_EXAMPLE=value')
        (self.root / 'example-alias').symlink_to('.env.example')
        WORKSPACE.check_workspace(self.root)

    def test_environment_aliases_and_chained_aliases_are_rejected(self):
        for filename in ['.env', '.env.local', 'config.env', 'config.env.production']:
            with self.subTest(filename=filename):
                target = self.root / filename
                target.write_text('FAKE_CANARY')
                alias = self.root / 'apparently-public.txt'
                alias.symlink_to(filename)
                chain = self.root / 'second-alias.txt'
                chain.symlink_to(alias.name)
                with self.assertRaisesRegex(WORKSPACE.WorkspaceError, 'environment_link'):
                    WORKSPACE.check_workspace(self.root)
                chain.unlink()
                alias.unlink()
                target.unlink()

    def test_external_file_and_directory_aliases_are_rejected(self):
        outside = self.parent / 'outside'
        outside.mkdir()
        (outside / 'data.txt').write_text('FAKE_CANARY')
        for target in [outside, outside / 'data.txt']:
            with self.subTest(target=target):
                alias = self.root / 'alias'
                alias.symlink_to(target)
                with self.assertRaisesRegex(WORKSPACE.WorkspaceError, 'external_link'):
                    WORKSPACE.check_workspace(self.root)
                alias.unlink()

    def test_hidden_paths_and_directory_aliases_cannot_hide_unsafe_links(self):
        hidden = self.root / '.cache'
        hidden.mkdir()
        (self.root / '.env').write_text('FAKE_CANARY')
        (hidden / 'content.txt').symlink_to('../.env')
        (self.root / 'cache-alias').symlink_to('.cache')
        with self.assertRaisesRegex(WORKSPACE.WorkspaceError, 'environment_link'):
            WORKSPACE.check_workspace(self.root)

    def test_dangling_and_cyclic_links_fail_closed(self):
        for target in ['missing', 'alias']:
            alias = self.root / 'alias'
            alias.symlink_to(target)
            with self.assertRaisesRegex(WORKSPACE.WorkspaceError, 'unresolved_link'):
                WORKSPACE.check_workspace(self.root)
            alias.unlink()

    def test_cli_rejects_before_exposing_file_contents(self):
        (self.root / '.env').write_text('FAKE_CANARY')
        (self.root / 'alias\nforged-log').symlink_to('.env')
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.root)],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('FAKE_CANARY', result.stderr)
        self.assertEqual(len(result.stderr.splitlines()), 1)
        self.assertIn('category=workspace', result.stderr)


if __name__ == '__main__':
    unittest.main()
