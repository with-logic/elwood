## 5. Public TypeScript API

The package MUST expose its public API from the package root and SHOULD define an
explicit package `exports` map so consumers do not depend on internal module
paths. The exact public type names can evolve, but the MVP must expose the
concepts in this section, including the stable `ElwoodErrorName` union.


### Sections

- [5.1 Starting Claude](5.1-starting-claude.md)
- [5.2 Resuming Claude](5.2-resuming-claude.md)
- [5.3 ClaudeSessionApi (the raw live session)](5.3-claude-session-api.md)
- [5.4 Events](5.4-events.md)
- [5.5 Starting Codex](5.5-starting-codex.md)
- [5.6 Resuming Codex](5.6-resuming-codex.md)
- [5.7 CodexSessionApi (the raw live session)](5.7-codex-session-api.md)
- [5.8 The session API — `ClaudeSession` / `CodexSession`](5.8-session-api.md)
- [5.9 Recurring session loops](5.9-loops.md)
