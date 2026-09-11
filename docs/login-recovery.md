# Recovering an expired Claude login

Purpose: how Elwood detects a lapsed Claude login and how `ClaudeSession.login`
recovers it in place, including its security properties and limits.

If Claude's login lapses, the CLI stops responding and shows a banner such as
"Login expired · Please run /login" or "Not logged in · Run /login". Elwood
surfaces this so a session never wedges silently:

- At startup, a login-expired banner rejects the start with
  `claude_not_authenticated`. The session is torn down, not reported usable.
- Mid-session, Elwood emits a content-free `login_expired` warning (and the
  matching `warning` activity) carrying `recoveryCommand: "/login"`, and leaves
  the session alive so you can recover without restarting.

## Driving `/login`

`ClaudeSession.login(options)` drives the interactive `/login` flow. The
default account login ends with a human copying an authorization code from a
browser, so `login` cannot complete unattended; it brackets the human step:

```ts
// Keep the event listener synchronous. Elwood's emitter ignores returned
// promises, so an async listener's rejection would be unhandled. Launch
// recovery from a separate function with its own catch.
session.on("warning", (w) => {
  if (w.code === "login_expired") void recoverLogin();
});

async function recoverLogin() {
  try {
    await session.login({
      onAuthUrl: (url) => openInBrowser(url), // optional: the browser sign-in URL
      provideCode: () => promptHumanForCode(), // required: the code from the browser
      // method defaults to "claudeai"; timeoutMs defaults to 300000
    });
  } catch (err) {
    // login_failed / login_timeout / session_not_running: decide whether to
    // retry, tear down, or alert a human. Never rethrow into the event loop.
    reportLoginFailure(err);
  }
}
```

`ClaudeLoginOptions.method` is `"claudeai"`, `"console"`, or `"third_party"`.

`login` runs as an exclusive transaction. It serializes with every other
control operation, so nothing interleaves with its picker keys, the code, or
its Enters, and it never sends keystrokes into a blocking dialog. It submits
`/login`, selects the login `method` if the CLI shows its picker, reports a
validated authorization URL via `onAuthUrl`, and, when the CLI asks for a code,
calls `provideCode`, validates the returned code (rejecting empty, oversized,
or control-bearing values), and submits it followed by exactly one Enter.
Screen stages count only when they newly appear after the `/login` submission,
so stale on-screen text cannot drive the flow. It resolves only after the CLI
reports success and the session reaches a fresh `ready` state, and rejects
with `login_failed` (an explicit failure, an invalid code, or a failing
`provideCode`), `login_timeout`, or `session_not_running`. A flow that
completes without prompting for a code never calls `provideCode`.

## Security considerations

`login` layers several defenses so an untrusted screen cannot hijack the flow:

- The transaction holds the control queue exclusively; nothing else writes
  during it.
- The scraped URL must be `https:` on an exactly-approved Anthropic host with
  no credentials, or the flow fails.
- The human-provided code is validated before it is written.
- Stage markers are scoped to the screen's active tail and must be new
  relative to a pre-`/login` baseline.
- Login keystrokes hold while a blocking dialog is on screen.
- The code prompt is re-checked as still current immediately before the code
  is written.

Two residual limitations remain by design:

- A single frame that renders both a genuine approved-host `claude.ai` OAuth
  URL and a paste-code prompt in the active region can still advance the flow.
  This requires forging a host-valid OAuth URL, not merely a phrase. Only run
  `login` when the session is genuinely at Claude's `/login` prompt, not while
  untrusted tool or model output is streaming into the terminal.
- The `/login` screen matchers are version-coupled to the Claude CLI and are
  covered by unit tests against captured CLI strings, not by a live e2e test:
  driving `/login` against a real authenticated session would mutate the
  developer's auth and cannot run unattended in CI.
