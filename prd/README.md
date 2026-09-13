# Elwood — Product Requirements Document

**A headless control layer for real interactive agentic coding CLIs.**

Status: Draft specification, ready for implementation planning
Platform: macOS for MVP
Primary surface: TypeScript library
First adapter: Claude Code CLI
Second adapter: OpenAI Codex CLI

This document specifies Elwood in enough detail that an engineer can implement
the first version without losing product intent. Anything observable by a
library consumer belongs here: public APIs, lifecycle behavior, hook semantics,
state layout, failure modes, and conformance criteria. Internal implementation
choices are left open where they do not change the public contract.

This specification is split across the files below. Each file keeps its
original section number, so a reference like §12A.7 or C-CLI-23 still
resolves exactly as it did when this was one document.

| Section | Topic | File |
|---|---|---|
| §1 | Overview | [01-overview.md](01-overview.md) |
| §2 | Goals and non-goals | [02-goals.md](02-goals.md) |
| §3 | Terminology | [03-terminology.md](03-terminology.md) |
| §4 | Product architecture | [04-architecture.md](04-architecture.md) |
| §5 | Public TypeScript API | [05-api/README.md](05-api/README.md) |
| §6 | Claude hook bridge | [06-claude-hook-bridge.md](06-claude-hook-bridge.md) |
| §7 | Claude tool and permission policy | [07-claude-policy.md](07-claude-policy.md) |
| §7A | Codex hook bridge and policy | [07a-codex-hook-bridge.md](07a-codex-hook-bridge.md) |
| §8 | State and persistence | [08-state.md](08-state.md) |
| §9 | Process lifecycle | [09-lifecycle.md](09-lifecycle.md) |
| §10 | Error model | [10-errors.md](10-errors.md) |
| §11 | Local test app | [11-test-app.md](11-test-app.md) |
| §12 | End-to-end testing | [12-e2e.md](12-e2e.md) |
| §12A | Headless command-line interface | [12a-cli.md](12a-cli.md) |
| §13 | Implementation latitude | [13-latitude.md](13-latitude.md) |
| §14 | Conformance | [14-conformance.md](14-conformance.md) |
| §15 | Open implementation notes | [15-open-notes.md](15-open-notes.md) |

## Conformance criteria

Every criterion ID (`C-API-*`, `C-CLI-*`, `C-CLAUDE-*`, `C-E2E-*`, and the
rest) is defined in [14-conformance.md](14-conformance.md). Tests name the
criterion they cover in their titles.
