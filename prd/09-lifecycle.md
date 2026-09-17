## 9. Process Lifecycle

### 9.1 Startup

`startClaude` performs these observable steps:

1. Resolve `cwd` and state directory.
2. Preflight platform support.
3. Preflight `claude` availability and version.
4. Create an Elwood session record.
5. Generate session-scoped Claude settings.
6. Start the local hook IPC endpoint.
7. Spawn the user's shell in a PTY.
8. Launch `claude` from that shell with generated settings and session env.
9. Return a `ClaudeSessionApi` object once the process and bridge are ready.

`startCodex` performs the analogous startup sequence for Codex:

1. Resolve `cwd` and state directory.
2. Preflight platform support.
3. Preflight `codex` availability and version.
4. Create an Elwood session record.
5. Generate session-scoped hook bridge runtime files.
6. Start the local hook IPC endpoint.
7. Spawn the user's shell in a PTY.
8. Launch `codex` from that shell with generated `--config` hook overrides and
   session env.
9. Return a `CodexSessionApi` object once the process and bridge are ready.

### 9.2 Compatibility checks

Elwood MUST check the installed Claude Code version during startup. The minimum
supported Claude Code version is `2.1.144`.

Elwood MUST check the installed Codex CLI version during `startCodex`. The
minimum supported Codex CLI version is `0.124.0`.

If `autoupdate` is true, Elwood first verifies that the CLI exists, then runs
the adapter's update command, then reads the version again before enforcing the
minimum version. The update step is BEST-EFFORT maintenance, not a control gate:
if the update command itself fails (nonzero exit, timeout, or a subprocess
error), Elwood MUST NOT fail startup on that basis. Instead it re-reads the
installed version and enforces the minimum as usual — if the installed CLI still
meets the minimum, Elwood records a typed `agent_update_failed` warning and
starts the session normally from the installed binary; only if the installed
version is below the minimum does startup fail (with the same typed
compatibility error below). A failed update is attempted at most once per parent
process and MUST NOT be retried per start, nor may one failed shared update
reject or poison any other otherwise-compatible start in the roster. If the
installed agent version is below the minimum after that optional update step,
startup fails with a typed error that names the required version and feature. If
the version cannot be parsed, Elwood records a typed `version_unparseable`
warning and continues by default, with an option for callers to make this fatal.

The `agent_update_failed` warning carries only safe diagnostics — the adapter,
the installed version that will be used, the update command's exit status, an
allowlisted error code (e.g. a timeout/`errno`), an optional content-free
`cleanupErrorCode` when probe termination remains unresolved, and bounded captured stderr —
never terminal transcripts, prompts, tokens, or environment secrets. Like all
warnings it is live-only and requires no consumer handling: a caller that does
not subscribe to the `warning` event is unaffected and the session still reaches
`ready`.

Version checks and optional `claude update` / `codex update` commands must run
through the user's configured macOS interactive login shell so PATH resolves as
it would in a normal Terminal.app session (see §4.2). Elwood uses the user's
configured login shell rather than trusting
an inherited `SHELL` environment override from the parent process.

These probes MUST run asynchronously and MUST NOT block the host process's
event loop: a parent that spawns a roster of sessions must not serialize their
preflights on a single thread. Elwood reads each adapter's `--version` at most
once per parent process — concurrent first reads share a single subprocess, and
later reads reuse the cached result — mirroring the once-per-process autoupdate
dedupe (C-LIFE-09). The cached version and adapter-capability reads are invalidated
after every coordinated update attempt, including a failed or peer-owned attempt,
because a failed installer may still have partially changed the binary. When
`autoupdate` is set, concurrent callers share one update and all validate the same
post-attempt version, so no caller proceeds on a stale pre-update version or races
a second update. This mutual exclusion also applies across separate Elwood parent
processes for the same macOS user and adapter: an atomic lease names the adapter in
a stable per-account cache independent of `TMPDIR`; contenders wait without
blocking the event loop, then invalidate their local caches and continue without
running a duplicate update. Contender waiting is bounded to 60 seconds; an owner
that has not finished by then causes the contender to skip its update and warn,
without deleting the owner’s lease. This warning uses `errorCode: "update_active"`
and a canonical message explaining that the update was skipped because another
updater remains active or its cleanup is unconfirmed. The lease records the owner's process id and a unique
generation. Cleanup removes only the generation it owns, a live owner is never
evicted solely because the stale bound elapsed, and recovery of a dead owner's
lease is itself serialized before removal, so neither cleanup nor concurrent stale
recovery can evict a successor. During an update lease, each probe starts behind a fixed stdin gate. Its process
group is durably recorded on the lease before the real CLI may execute. A failed
registration never opens the gate; an aborted or expired gate cannot open later.
The live owner's normal registered probe remains a wait condition for contenders;
a dead owner's surviving group retains exclusion. The active parent owns the entire update callback, including gaps between
registered probes. Cleanup-marked records instead use group-only liveness.
Validated stale-owner recovery also removes known temporary owner records. Registration writes that finish
late retain lease ownership until they settle, so they cannot overwrite a successor.
A normally exiting update probe does not release its lease while descendants
remain in its registered process group. Elwood waits up to one additional second
for that group to exit, then retains the lease and reports unconfirmed cleanup;
normal completion does not signal the group. Aborted probes retry process-group termination,
fall back to terminating the direct child, and await exit within a bounded
cleanup window. If the group cannot be confirmed gone, the lease retains that
process-group identity even after the parent exits. Contenders skip their update
and receive a bounded cleanup warning rather than waiting indefinitely or starting
a competing installer. Recovery removes this guard only after confirming the
recorded process group has exited; elapsed time or the parent's death alone is
insufficient. Within one parent process, a FAILED shared update
is likewise shared once — every concurrent caller observes the same failure,
re-reads the installed version, and proceeds through the compatibility gate; the
failure is never cached in a way that rejects those callers or poisons a later
start. A contender in another parent process does not receive the owner's live
warning event; after the lease releases it re-reads and validates the installed
binary without retrying the failed update. More generally, any per-process cached
probe (version read, capability detection, update) that fails is not retained as a
rejected result: a later caller re-attempts rather than inheriting the prior
failure.

Each probe is bounded so a broken or hostile CLI on PATH cannot hang or flood
the host: a probe that does not exit within a default timeout (15 seconds) or
whose captured output exceeds a per-stream byte cap (1,000,000 bytes) is
killed, and its captured output is truncated to the cap. Abort cleanup has an
additional one-second bound. Every unresolved aborted probe, including version
and capability probes, remains owned by an asynchronous reaper while the parent
is alive. Retries use an unreferenced timer, do not prolong host shutdown, and
stop signaling after a successful group kill; ownership ends when the group is
confirmed gone. Update groups additionally retain durable exclusion as described above. Truncation happens on
a UTF-8 code-point boundary — an incomplete trailing sequence is dropped — so
the decoded output re-encodes to at most the cap rather than growing via a
replacement character. This applies to every
non-PTY probe — `--version`, `--help` capability detection, and
`claude update` / `codex update`. A `--version`/`--help` failure (bounded or
otherwise) surfaces through that probe's existing public error name —
`claude_start_failed` / `codex_start_failed` — with the underlying reason
preserved in the error `details` as `cause` (and `errno`, e.g. `ETIMEDOUT` on
timeout or `E2BIG` on overflow) alongside any `stderr`. An UPDATE failure
(`claude update` / `codex update`), being best-effort maintenance, does NOT
surface as a start-blocking error; it is contained and surfaces as the live
`agent_update_failed` warning carrying the same bounded diagnostics (exit status,
`errno`, `stderr`), while startup continues through the compatibility gate. A
killed probe is signaled only because Elwood aborted it; a probe that exits or
fails to spawn on its own is not signaled.

After spawning the PTY, Elwood waits briefly for immediate process exits or
known authentication/startup failure banners before reporting the session as
running. The default wait must be long enough to catch typical local CLI startup
failures without turning `startClaude` or `startCodex` into a readiness wait for
the first agent prompt. Authentication banner matching is best-effort and should
cover the common `not authenticated`, `login required`, `authentication failed`,
and non-MCP `not logged in` forms, as well as lapsed-session banners that only
direct the user to re-run `/login` (`Login expired`, `Session expired`,
`OAuth token revoked`, or `Not logged in`, each paired with a `run /login`
recovery hint).

Once the live resources exist (hook bridge, PTY, terminal, and transcript
watcher), every remaining startup step runs behind a single cleanup boundary: the
flush of any transcript diagnostics buffered before the session sink existed
(emitted as live warnings), PTY-exit registration, the readiness/authentication
assertion, and the startup-usable evidence. If ANY of them fails, Elwood tears
down the now-live PTY, hook bridge, terminal, and transcript watcher before
rejecting, so a failed `startClaude`/`startCodex` never leaks a live process, IPC
endpoint, or file watcher. (The one-shot version/preflight warning is NOT part of
this boundary — it is scheduled for delivery AFTER start resolves, per C-API-14.) Tearing down the PTY routes through the SAME one-shot
process-group reap the normal exit path uses (§9.4, C-LIFE-10): the PTY is
signaled, its exit is awaited within a bounded window, and the leader's process
group is SIGKILLed on every path — even if the PTY signal throws — so a
CLI-spawned descendant such as a hook-bridge grandchild (which POSIX reparents to
PID 1 the instant the leader exits) cannot survive or reparent past a failed
startup. The original startup error is preserved; a cleanup or reap failure is
secondary and never replaces it.

### 9.3 Resume

`resumeClaude` loads the Elwood session record and starts a new wrapper around
the same logical Claude conversation using Claude Code's resume mechanism.

Resume must re-establish hook routing, regenerate settings, and re-establish PTY
control. It does not restore any persisted terminal size (that
is not persisted, §8.2): the caller passes `initialSize` on resume to set
geometry, which otherwise falls back to the default. Resume must not require
callers to know Claude's internal session ID.
Resume must reject session records owned by another adapter and must fail
explicitly when the Claude resume id is not available.
Resume defaults the launch posture (privilege and tool policy) from the persisted
session record, as specified in §5.2: a bare `resumeClaude` relaunches with the
same `permissionMode`, `allowedTools`, `disallowedTools`, and `tools` the session
started with, so tool restrictions cannot silently loosen across a resume.
Explicit resume options override the persisted posture field by field, and the
effective posture is re-persisted. Model and caller config overrides remain
caller-supplied-per-call and are intentionally not persisted yet.

`resumeCodex` loads the Elwood session record and starts a new wrapper around the
same logical Codex conversation using `codex resume <SESSION_ID>` when Elwood has
observed and persisted Codex's session id. Resume must reject session records
owned by another adapter and must fail explicitly when the Codex resume id is not
available.
Resume defaults the launch posture (sandbox and approval policy) from the
persisted session record, as specified in §5.2, so a bare `resumeCodex` relaunches
with the same `sandbox` and `approvalPolicy` the session started with and
restrictions cannot silently loosen. Explicit resume options override the
persisted posture field by field, and the effective posture is re-persisted.
Model and caller config overrides remain caller-supplied-per-call and are
intentionally not persisted yet.

For either adapter, resume validates the loop sidecar before starting the agent,
silently removes definitions whose seven-day wall-clock expiry passed during
downtime, and restores surviving definitions with the same IDs and persisted
jitter. It restores no timer or due state: every surviving cadence starts fresh
from the resumed session's first readiness, using that launch's current
permissions and blocking-dialog posture, and no missed run is replayed.

### 9.4 Exit

When the agent process exits, Elwood emits terminal/process exit events and
updates the live session status. It keeps the persisted session record and
generated files, including loop definitions, unless kill or teardown is
requested. Any unsubmitted due state is discarded. (Session status is live-only and is
not written to the record, §8.2.)

Reaping the leader's process group is unconditional on every exit path
(C-LIFE-10). On an unsolicited PTY exit the terminal status is submitted first,
then the group is reaped in a `finally`, so transcript-drain, warning-emission, or
status-listener failures can never skip the reap; a reap failure there surfaces as
a live `reap_failed` warning rather than aborting the exit callback. An explicit
`stop()`/`kill()` on an already-terminal session performs only the one-shot
survivor reap (it does not re-signal the dead PTY — node-pty does not replay the
exit event, and the pid may already be recycled) and rejects with a typed
`termination_failed` error if that reap fails, leaving the reap retryable by a
later `teardown()`.

Overlapping `stop()`, `kill()`, and `teardown()` calls on one session are
serialized so the PTY is signaled at most once. The first caller owns the in-flight
shutdown; a concurrent caller of the same or a lower urgency joins that same
in-flight operation rather than snapshotting status independently and re-signaling
a PID that may already have exited and been recycled. A more urgent call (a
`kill()` during an in-flight `stop()`, or a `teardown()`) escalates by running after
the in-flight shutdown settles, then performs only the one-shot survivor reap and
its own extra work (e.g. teardown's file removal) and never issues a second PTY
signal. Signal ownership is tracked INDEPENDENTLY of lifecycle status: once any
shutdown has signaled the PTY, no later caller re-signals it — not even when the
predecessor signaled and reaped but failed before submitting a terminal status, so
the session is still non-terminal. Such a later caller may still reap, clean up,
and (for teardown) remove files. A settled shutdown failure is not permanently
sticky: because signal ownership is separate from the in-flight promise, a later
`stop()`/`kill()`/`teardown()` after a failed one runs a fresh attempt that RETRIES
the reap, runtime cleanup, and file removal — without re-signaling the PTY — rather
than returning the earlier rejection forever (C-LIFE-10 retry posture). Each caller
still observes its own operation's success or typed failure.
