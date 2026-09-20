"""Denied cleanup signals preserve outcomes and bounded reaping (PRD §16)."""
import contextlib
import io
import subprocess
import unittest
from unittest.mock import Mock, patch
from capped_cleanup_test import capped


class PermissionTest(unittest.TestCase):
    def run_denied(self, outcomes, kill_error=None):
        child = Mock(pid=123)
        child.wait.side_effect = outcomes
        child.kill.side_effect = kill_error
        diagnostic = io.StringIO()
        with patch.object(capped.subprocess, 'Popen', return_value=child), \
                patch.object(capped.os, 'killpg', side_effect=PermissionError('PRIVATE_CANARY')) as killpg, \
                contextlib.redirect_stderr(diagnostic):
            result = capped.run(1, ['fixture'])
        self.assertEqual([call.args[1] for call in killpg.call_args_list],
                         [capped.signal.SIGTERM, capped.signal.SIGKILL])
        self.assertNotIn('PRIVATE_CANARY', diagnostic.getvalue())
        self.assertLess(len(diagnostic.getvalue()), 512)
        self.assertIn('scope=group signal=SIGTERM reason=permission_denied', diagnostic.getvalue())
        self.assertIn('scope=group signal=SIGKILL reason=permission_denied', diagnostic.getvalue())
        child.kill.assert_called_once_with()
        self.assertEqual(child.wait.call_args.kwargs, {'timeout': 1})
        return result, diagnostic.getvalue()

    def test_denied_group_signals_preserve_timeout_and_kill_direct_child(self):
        timeout = subprocess.TimeoutExpired('fixture', 1)
        result, _ = self.run_denied([timeout, timeout, -9])
        self.assertEqual(result, 124)

    def test_denied_group_signals_preserve_completed_exit_and_signal_status(self):
        for code, expected in [(0, 0), (2, 2), (-9, 137)]:
            with self.subTest(code=code):
                result, _ = self.run_denied([code, code, code], ProcessLookupError())
                self.assertEqual(result, expected)

    def test_denied_child_kill_and_unreaped_child_are_explicit(self):
        timeout = subprocess.TimeoutExpired('fixture', 1)
        result, diagnostic = self.run_denied([timeout, timeout, timeout], PermissionError('PRIVATE_CANARY'))
        self.assertEqual(result, 124)
        self.assertIn('scope=child signal=SIGKILL reason=permission_denied', diagnostic)
        self.assertIn('scope=child reason=reap_timeout', diagnostic)

    def test_interruption_outcome_survives_denied_cleanup(self):
        child = Mock(pid=123)
        child.wait.side_effect = [SystemExit(143), 0, 0]
        with patch.object(capped.subprocess, 'Popen', return_value=child), \
                patch.object(capped.os, 'killpg', side_effect=PermissionError()), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                capped.run(1, ['fixture'])
        self.assertEqual(raised.exception.code, 143)
        child.kill.assert_called_once_with()

    def test_broken_diagnostic_sink_cannot_replace_timeout_or_skip_cleanup(self):
        for error in (BrokenPipeError(), ValueError('closed stream')):
            with self.subTest(error=type(error).__name__):
                child = Mock(pid=123)
                timeout = subprocess.TimeoutExpired('fixture', 1)
                child.wait.side_effect = [timeout, timeout, -9]
                with patch.object(capped.subprocess, 'Popen', return_value=child), \
                        patch.object(capped.os, 'killpg', side_effect=PermissionError()), \
                        patch.object(capped.sys, 'stderr', Mock(write=Mock(side_effect=error))):
                    self.assertEqual(capped.run(1, ['fixture']), 124)
                child.kill.assert_called_once_with()
                self.assertEqual(child.wait.call_count, 3)
