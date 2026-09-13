## 11. Local Test App

The repository should include a small local developer test app. It is not the
product's primary surface, but it is required for manual acceptance testing.

The browser dev app should be launched with `npm run dev:web`, but its
PTY-owning process SHOULD run under Node when using `node-pty`, because the
native PTY binding is a Node dependency. npm remains the package script runner,
and Vitest is the default test runner.

The repository should also include runnable examples for the public library API.
Examples that own real PTYs SHOULD be exposed through package scripts that run a
small Node supervisor, rather than asking developers to invoke
`node --experimental-strip-types` directly. Example output should demonstrate
Elwood as a headless library by logging structured events, not by mirroring the
wrapped agent's raw terminal stream into the caller's shell.

The test app must:

- start a Claude or Codex session for a selected `cwd`;
- resume a saved Elwood session ID;
- render the live PTY session with xterm.js or an equivalent terminal renderer;
- send prompts, including multi-line prompts;
- send raw key/input sequences;
- resize the terminal;
- show current session status;
- show a chronological live hook/event log with event name, timestamp, payload
  summary, handler result summary, and whether Claude received no decision,
  allow, deny, block, context, or another response;
- show rich structured debugger entries for hooks, unified activity events,
  warnings, hook errors, lifecycle status, terminal exits, and startup/runtime
  errors;
- provide an inspector for each debugger entry that exposes the raw structured
  payload as formatted JSON so developers can validate typed fields without
  reading terminal escape output;
- visually delineate debugger entries by event kind and severity with compact
  labels, color, timestamps, and searchable/filterable categories;
- support a manual smoke test where a developer can have a conversation with
  Claude or Codex and visibly confirm hook coverage;
- clean up its HTTP server, WebSocket server, active Elwood session, and child
  process tree on SIGTERM/SIGHUP and job-control signals such as SIGTTIN. On
  SIGINT/Ctrl-C, it MUST immediately SIGKILL descendant processes and itself
  without waiting for graceful cleanup. The `dev:web` package script should run
  the web server under a small process supervisor so terminal Ctrl-C can kill the
  entire spawned process group even if the app-level handler or an agent child is
  wedged. The web dev app must not read from stdin for shutdown handling because
  terminal reads can suspend the job instead of killing it. When a browser
  session starts or resumes, the PTY mirror should render only raw replayed and
  live `terminal:data` chunks in its visual xterm.js instance so startup TUI
  bytes remain visible without clearing or rewriting the visual terminal from a
  headless snapshot.

The test app must not become required for library consumers.
