"""Copy bounded complete-attempt stderr in the fake-CLI fixture only (PRD §16)."""
from pathlib import Path
import sys
import tempfile


def retain_failure(root, scope, attempt, code, paths):
    if code == '0':
        return
    with tempfile.NamedTemporaryFile(dir=root, prefix='capped-attempt.', suffix='.failure', delete=False) as report:
        report.write(f'lens={scope} attempt={attempt} exit={code}\n'.encode())
        remaining = 2048
        for path in paths:
            with Path(path).open('rb') as source:
                payload = source.read(remaining)
            report.write(payload)
            remaining -= len(payload)


if __name__ == '__main__':
    retain_failure(*sys.argv[1:5], sys.argv[5:])
