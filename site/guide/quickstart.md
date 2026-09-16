# Quickstart

Start in a project you know. The first prompt below asks for an explanation, so you can see the whole round trip before asking an agent to make changes.

## Before you start

You need macOS, Node.js 24+, and an installed, authenticated Claude Code or Codex CLI. This guide uses Claude Code.

```sh
node --version
claude --version
```

If Claude is not installed, follow the [Claude Code installation guide](https://code.claude.com/docs/en/quickstart). Run `claude` once in your terminal and complete its sign-in flow. See [Claude authentication](https://code.claude.com/docs/en/authentication) for your account or organization setup. Then exit that session and return to your shell.

Elwood uses the agent's normal environment and authentication. Installing Elwood does not create an account or include model usage.

## From the shell

Install the executable:

```sh
npm install -g @with-logic/elwood
```

From your project directory, ask one question:

```sh
elwood "Explain this project in three sentences."
```

Elwood starts Claude in a hidden terminal, waits for one turn, prints the assistant's reply and exits. The exact answer depends on your project. Diagnostics go to stderr; the answer goes to stdout.

Pin one agent if you have both installed:

```sh
elwood config set agent claude
elwood "Where are the tests?"
```

With no `--agent`, Elwood uses the first agent it finds installed: Claude Code, then Codex. Pass `--agent codex` (or set `ELWOOD_AGENT`) to choose explicitly. [Continue with the CLI guide](cli.html).

## From TypeScript

Install the library in your project:

```sh
npm install @with-logic/elwood
```

Save this as **ask.mts**. The `.mts` extension makes this an ES module, including top-level `await`.

```ts
import { ClaudeSession } from "@with-logic/elwood";

const session = new ClaudeSession({
  cwd: process.cwd(),
  autotrust: true, // Approve allowlisted trust prompts for this known project.
});

try {
  const reply = await session.send(
    "Explain this project in three sentences.",
    { timeoutMs: 120_000 },
  );
  console.log(reply);
} finally {
  await session.close();
}
```

Run it with Node.js 24+:

```sh
node ask.mts
```

`autotrust: true` approves allowlisted workspace and extension trust prompts. Use it
only for a project and extensions you trust. To keep the library default of
`autotrust: false`, first run `claude` in this exact project directory, approve its
trust prompts, and exit. A hidden session cannot ask you to approve them.

`new ClaudeSession()` is synchronous. The first `send()` starts the agent; the constructor alone does not. `send()` resolves to a string after the turn settles. `finally` closes the process even if the turn fails.

The turn timeout bounds the response wait. It does not itself kill the agent, and it is not a whole-launch timeout. The `finally` block still matters. Use the CLI's `--timeout` when you need a single deadline covering launch and the turn.

## Follow-up turns

Reuse the same session before closing it:

```ts
const overview = await session.send("Explain the architecture.");
const nextStep = await session.send("Which part should I read first?");
```

The second turn keeps the first turn's context. For the full runnable pattern, streaming events, and lifecycle details, [continue with sessions](sessions.html).

## If the first run fails

Run the selected agent directly in the same directory. Finish login or any first-run setup, then retry Elwood. If the command is quiet, add `--verbose` to see lifecycle progress without mixing it into the answer. [Find the matching symptom](troubleshooting.html).
