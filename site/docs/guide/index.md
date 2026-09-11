# What Elwood is

Elwood lets you drive Claude Code or Codex from TypeScript and the command line. Underneath, the agent runs in a real interactive terminal, with its own tools, configuration and authenticated account.

You do not need to parse terminal escape codes or guess when the agent has finished a turn.

## Two ways in

**From your shell:** install the `elwood` executable, pipe in a diff, and get an answer you can use in a script. [CLI quickstart](quickstart.html#from-the-shell).

**From your app:** create a `ClaudeSession`, call `send()`, and get a string back. [TypeScript quickstart](quickstart.html#from-typescript).

```sh
npm install -g @with-logic/elwood
elwood "Explain this project's architecture."
```

```ts
import { ClaudeSession } from "@with-logic/elwood";

const session = new ClaudeSession();
try {
  const reply = await session.send("Explain this project's architecture.");
  console.log(reply);
} finally {
  await session.close();
}
```

## What happens on send

1. Elwood starts the selected agent in a hidden terminal, in your project directory.
2. It waits until the agent is ready and submits your prompt.
3. The agent uses its normal tools. Elwood observes structured activity and the turn boundary.
4. Your call resolves with the assistant's reply. The same session can be continued with further prompts as needed.

A **session** is a running conversation with one agent in one workspace. A **turn** is one prompt and its response. A **PTY** is the operating system's terminal interface: it gives the agent the interactive environment it expects even when your app has no terminal window.

## What Elwood owns

Elwood handles terminal startup, prompt delivery, typed activity, turn completion, process cleanup, and even agent updates (if enabled). Claude Code or Codex still owns model access, account authentication, its tools and its conversation history.

The agent can read and change files according to its launch permissions. [Choose the permissions your task needs](permissions.html).

## Where to go next

- [Quickstart](quickstart.html): prerequisites, install and a runnable example.
- [Sessions and streaming](sessions.html): follow-ups, streaming, images and cleanup.
- [CLI](cli.html): prompts, pipelines, JSON, session and model listings, and the agent's own terminal.
- [Recipes](recipes.html): scripts with complete error paths.
- [TypeScript reference](api.html): classes, options, events and lifecycle methods.
- [Troubleshooting](troubleshooting.html): installation, login, blocked prompts and timeouts.

## Runtime support

The initial release targets **macOS and Node.js 24 or newer**. Elwood is a local/server-side Node library with a native PTY dependency. It does not run inside a browser. The agent must be installed and authenticated. With no agent selected, the CLI uses the first one it finds (Claude Code, then Codex) and never switches mid-session.

These docs use the distribution name **[@with-logic/elwood](https://www.npmjs.com/package/@with-logic/elwood)** and the executable name **elwood**.
