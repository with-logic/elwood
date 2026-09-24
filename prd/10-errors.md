## 10. Error Model

Elwood errors exposed to library callers must be typed and stable. Error names
should be string-literal discriminants.

Initial required error names:

| Error name | Meaning |
|---|---|
| `unsupported_platform` | The current OS is not supported by the implementation. |
| `claude_not_found` | `claude` could not be resolved or spawned. |
| `claude_start_failed` | Claude started but exited or failed before the session was usable. |
| `claude_update_failed` | `claude update` failed. Best-effort: contained by the autoupdate preflight and surfaced as the `agent_update_failed` warning (never thrown out of `startClaude` when the installed CLI meets the minimum). |
| `claude_not_authenticated` | Startup output or status indicates Claude is not authenticated. |
| `claude_version_unsupported` | Installed Claude version lacks required features. |
| `claude_invalid_reasoning_effort` | `reasoningEffort` was not one of the valid `ClaudeReasoningEffort` values; rejected before spawn. |
| `claude_high_trust_conflict` | `highTrust: true` was combined with an explicit `permissionMode`; rejected before spawn. |
| `codex_not_found` | `codex` could not be resolved or spawned. |
| `codex_start_failed` | Codex started but exited or failed before the session was usable. |
| `codex_update_failed` | `codex update` failed. Best-effort: contained by the autoupdate preflight and surfaced as the `agent_update_failed` warning (never thrown out of `startCodex` when the installed CLI meets the minimum). |
| `codex_not_authenticated` | Startup output or status indicates Codex is not authenticated. |
| `codex_version_unsupported` | Installed Codex version lacks required features. |
| `codex_invalid_reasoning_effort` | `reasoningEffort` was not one of the valid `CodexReasoningEffort` values; rejected before spawn (Codex would otherwise fail server-side at the first turn). |
| `codex_high_trust_conflict` | `highTrust: true` was combined with an explicit `sandbox` or `approvalPolicy`; rejected before spawn. |
| `state_not_found` | A requested Elwood session record does not exist. |
| `state_corrupt` | A session record exists but cannot be parsed or validated. |
| `adapter_mismatch` | A resume request targeted a session record owned by another adapter. |
| `resume_unavailable` | A resume request cannot be completed from available session metadata. |
| `pty_start_failed` | PTY or shell startup failed. |
| `hook_bridge_failed` | The hook bridge or IPC endpoint could not be initialized. |
| `input_queue_full` | A live session control queue would exceed 1,024 outstanding operations or 8 MiB aggregate UTF-8 input text; no input or attachment is performed for the rejected operation. |
| `session_not_running` | Operation requires a running process but the session is stopped. |
| `termination_failed` | A stop/kill request did not observe process exit after escalation, or the PTY exited but its process group could not be confirmed reaped. |
| `teardown_failed` | Elwood could not remove all owned session files. |
| `compact_failed` | A requested conversation compaction did not report completion in time. |
| `interrupt_failed` | A requested turn interrupt did not return the session to ready in time. |
| `model_automation_failed` | The adapter's model picker could not be recognized or driven to completion. |
| `login_failed` | The interactive `/login` re-authentication flow reported an explicit failure or an invalid authorization code. |
| `login_timeout` | The interactive `/login` re-authentication flow did not report success before the timeout. |
| `invalid_image` | An `images` input is not attachable: an unsupported/absent byte format, empty bytes, a path that is not a readable file, or a total image count/size beyond the documented limits (C-API-44). Raised before any partial input reaches the composer. |
| `image_attach_failed` | An image could not be confirmed attached: the CLI's `[Image #N]` chip did not appear before the confirmation timeout, the OS clipboard could not be read/written, or terminal rendering permanently failed. No text is submitted afterward. (A session that TERMINATES mid-attach rejects with `session_not_running`, like any queued op.) (C-API-44/45/46) |
| `wait_timeout` | A `waitForStatus`/`waitForActivity` call did not observe its condition before the timeout, or the PTY rejected a staged-draft cleanup write before successor input. Cleanup failures retain the pending draft and use a bounded message without raw PTY diagnostics. |
| `invalid_loop` | A loop request or recognized `/loop` command violates the documented shape, interval, or UTF-8 message bounds. |
| `loop_limit_reached` | Creating a loop would exceed 50 unexpired definitions; existing loops are unchanged. |
| `loop_not_found` | Cancellation targeted an unknown or already-finished loop ID. |
| `loop_persistence_failed` | A loop-sidecar write required by creation, cancellation, kill, expiry, or teardown did not complete safely. |
| `loop_submission_failed` | Live loop scheduling or readiness-safe prompt submission failed; details identify only the loop ID. |

Hook handler failures are normally surfaced as `hookError` events, not thrown
from the hook bridge path.

Startup errors MUST NOT swallow their underlying cause: `pty_start_failed`,
`hook_bridge_failed`, and adapter start failures carry the underlying error
message in `details.cause`, plus `errno`, `syscall`, and `path` fields when
the underlying error exposes them, so consumers can diagnose environment
failures without instrumenting Elwood internals.
