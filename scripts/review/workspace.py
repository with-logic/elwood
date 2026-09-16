#!/usr/bin/env python3
"""Reject symlinks that bypass review file permissions; see .github/PIPELINE.md."""
import fnmatch
import json
import os
from pathlib import Path
import sys


class WorkspaceError(ValueError):
    """A workspace cannot safely use the reviewer's path-based read rules."""


def environment_file(name):
    return (
        fnmatch.fnmatchcase(name, '*.env')
        or fnmatch.fnmatchcase(name, '*.env.*')
    ) and not fnmatch.fnmatchcase(name, '*.env.example')


def check_workspace(directory):
    root = Path(directory).resolve(strict=True)
    if not root.is_dir():
        raise WorkspaceError('not_directory')

    def scan_error(error):
        raise error

    # Include hidden and ignored paths: model file tools can reach those too.
    # Never traverse directory links; resolve each link before allowing review.
    for parent, directories, files in os.walk(root, followlinks=False, onerror=scan_error):
        for name in directories + files:
            path = Path(parent, name)
            if not path.is_symlink():
                continue
            label = json.dumps(str(path.relative_to(root)))
            try:
                target = path.resolve(strict=True)
            except (OSError, RuntimeError):
                raise WorkspaceError(f'unresolved_link path={label}') from None
            if target != root and root not in target.parents:
                raise WorkspaceError(f'external_link path={label}')
            if environment_file(target.name):
                raise WorkspaceError(f'environment_link path={label}')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise WorkspaceError('expected_workspace_argument')
        check_workspace(sys.argv[1])
    except (WorkspaceError, OSError, RuntimeError) as error:
        reason = str(error) if isinstance(error, WorkspaceError) else type(error).__name__
        print(f'review: phase=preflight category=workspace reason={reason}', file=sys.stderr)
        sys.exit(1)
