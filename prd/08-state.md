## 8. State And Persistence

### 8.1 State directory

By default, Elwood stores session metadata under:

```text
<cwd>/.elwood/
```

Callers may override this with `stateDir`. Relative `stateDir` values MUST be
resolved to absolute paths before state is written or read, so equivalent path
spellings address the same session store. When Elwood initializes the default
project-local state directory, it should create `.elwood/.gitignore` when that
file does not already exist. Elwood MUST NOT overwrite an existing gitignore
file and MUST NOT create gitignore files in caller-provided custom state
directories unless a future explicit option asks it to.
The default `.elwood/` directory and generated `.elwood/.gitignore` should be
readable by normal local tooling, while session-specific subdirectories remain
private.

Before creating or changing state, Elwood MUST reject a symlink at the state
root, sessions directory, or session directory, and reject user-owned symlink
ancestors that redirect those paths. System-owned path aliases (such as macOS
`/tmp`) remain supported. Directory permission changes and generated-file writes
MUST use no-follow descriptors and verify ownership/type before changing them.
Unsafe state paths fail as `state_corrupt` before touching the linked target.
These checks protect against planted checkout paths; they do not isolate a
hostile process already running as the same OS user.

The hook bridge's Unix domain socket MUST NOT live under `stateDir`. Socket
paths are capped near 104 bytes on macOS (`sockaddr_un.sun_path`), so a socket
inside a caller-structured `stateDir` breaks any parent app with nested state
layouts. Instead, each session has a STABLE Elwood-owned private (0700) socket
home directory under the OS temp dir, named by a bounded, collision-resistant
fingerprint of the session's full identity — its `stateDir`, adapter, and session
id — so every start/resume of that session resolves the SAME home even after a
parent restart (the record persists nothing about it), while two sessions that
share an explicit session id in different state dirs get DISTINCT homes and can
never sweep each other's live socket. Each
launch binds a FRESH socket FILE inside that home, so a stale socket is never
reused; the socket path is a per-launch runtime value, embedded only in the generated
private bridge script and never in the session record, so a
recorded socket path can never be trusted. `teardown` removes the whole socket
home (every launch's socket) along with the session directory, so no per-launch
socket can leak undiscoverably across restart/resume cycles. Because `teardown`
removes the whole home, running two live sessions that share a full identity
(`stateDir`, adapter, and session id) concurrently is UNSUPPORTED — they would
also share the session directory, record file, and resume id, and one's teardown
would remove the other's live socket. A given session identity has at most one
live session at a time; a failed START (not a teardown) removes only its own
socket file, so an overlapping failed launch never disturbs a live one. `stateDir`
length MUST NOT constrain whether a session can start.

### 8.2 Session record

The schema-version-1 core session record persists only the minimum needed to
resume or tear down a session after
the parent app restarts. The persisted record is deliberately small: everything a
running session needs beyond it is regenerated at each start/resume. Runtime
bridge scripts contain the fresh IPC token and socket path in owner-only files. The persisted fields are exactly:

- schema version;
- `elwoodSessionId`;
- adapter kind (`claude` or `codex`);
- original `cwd`;
- per-adapter resume state: the CLI's own internal conversation id needed to
  resume, and the resolved launch posture (the privilege and tool-policy options
  the session was launched with — `permissionMode`, `allowedTools`,
  `disallowedTools`, `tools` for Claude; `sandbox`, `approvalPolicy` for Codex),
  so resume re-derives its launch configuration and cannot silently loosen
  privileges.

Nothing else is persisted in the core record. In particular it MUST NOT persist session status,
timestamps, warnings, terminal size, the hook bridge
authentication token, the socket path, or any Elwood-owned runtime file paths.
Status and warnings are live-only (§5.7). Runtime file paths are pure functions of
the state directory, session id, and adapter, so they are DERIVED on demand rather
than stored. The socket HOME is a deterministic function of that same identity (a
bounded fingerprint, §8.1), so every launch resolves the same one without storing
it. The bridge authentication token and the socket FILE inside that home are minted
FRESH on every start and resume and never trusted from disk — a recorded token or
socket path is never read back.

Elwood-generated session directories MUST be private to the current user
(`0700`), and generated settings, bridge scripts, and session records MUST be
written as private files (`0600`) because they can contain local IPC credentials.
State writes MUST be rename-atomic and fsync-backed where the platform supports
it. Crash recovery is a product requirement.
Session records are not intended to be portable across unrelated state
directories. Session IDs are opaque path components: absolute paths, path
separators, and traversal segments are invalid.

Loop definitions are stored separately so existing schema-version-1 session
records remain backward-readable. A versioned loop sidecar under the same
owner-only session directory contains exactly each validated loop's stable ID,
mode, message, fixed interval when applicable, stable jitter, creation time, and
expiration time; it contains no timer, due state, submission state, or prior
phase. An absent sidecar means that the session has no loops. The sidecar uses
rename-atomic, fsync-backed writes under the same crash-recovery rules and MUST
be mode `0600`. On every read Elwood rejects malformed data, a sidecar not owned
by the current user, or any group/world permission bits as `state_corrupt`; it
must never restore or execute those definitions.

### 8.3 What must not be persisted by default

Elwood MUST NOT persist raw PTY input/output, ordinary prompts, terminal
transcripts, hook payloads, hook responses, or conversation content by default.
The exact prompt in a caller-created loop is an explicit, narrow exception: it
is durable automation state in the loop sidecar, not an observed chat transcript.

Hook events are live-only by default. Terminal data is live-only by default.

Parent applications may implement their own logging outside Elwood, but Elwood's
core state must not become a transcript store.

### 8.4 Cleanup

Runtime files needed for resume/debugging are kept by default after `stop`.
Loop definitions are likewise kept after `stop`, unexpected exit, or process
failure. `kill` permanently removes all loop definitions while preserving the
ordinary session record; a later resume has no loops.

`teardown` removes all Elwood-owned traces for that session, including session
metadata, generated settings/config, bridge route records, sockets, and
temporary files. It must not remove agent-owned global transcripts/auth state or
project/user settings that Elwood did not create.
