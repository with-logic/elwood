#!/usr/bin/env bash
# Frames complete bounded evidence for OpenCode stdin; implements PRD §16.
# OpenCode file attachments use ReadTool limits, so do not use them for evidence.
write_input() {
  local path name
  for path in "$@"; do
    name=$(basename "$path")
    printf '\n--- BEGIN %s ---\n' "$name"
    cat "$path"
    printf '\n--- END %s ---\n' "$name"
  done
}
