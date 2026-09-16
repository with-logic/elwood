#!/usr/bin/env python3
"""Reject changed environment-file paths before attaching a diff; implements PRD §16; see .github/PIPELINE.md."""
import os
import sys
from workspace import environment_file


def check_paths(data):
    for raw in data.split(b'\0'):
        if raw and environment_file(os.path.basename(os.fsdecode(raw))):
            raise ValueError('environment_file_changed')


if __name__ == '__main__':
    try:
        check_paths(sys.stdin.buffer.read())
    except ValueError as error:
        print(f'review: phase=preflight category=diff_paths reason={error}', file=sys.stderr)
        sys.exit(1)
