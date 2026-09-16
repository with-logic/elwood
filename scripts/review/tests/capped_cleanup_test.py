"""Drive an interruption at the supervisor's grace-period wait boundary."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('capped', Path(__file__).resolve().parents[1] / 'capped.py')
capped = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capped)


class CleanupTest(unittest.TestCase):
    def test_interruption_during_grace_wait_still_kills_and_reaps(self):
        class Child:
            pid = 123
            calls = 0

            def wait(self, timeout=None):
                self.calls += 1
                if self.calls == 1:
                    raise subprocess.TimeoutExpired('fixture', timeout)
                if self.calls == 2:
                    raise SystemExit(143)
                return -9

        child = Child()
        with patch.object(capped.subprocess, 'Popen', return_value=child), patch.object(capped, 'stop_group') as stop:
            with self.assertRaises(SystemExit):
                capped.run(1, ['fixture'])
            self.assertEqual(child.calls, 3)
            self.assertEqual(stop.call_args_list[-1].args, (123, capped.signal.SIGKILL))
