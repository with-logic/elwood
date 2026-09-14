# Sessions and streaming

Create one session per conversation. Send related prompts to that session, and close it when the conversation is finished. Each session belongs to one agent and workspace.

## Send and follow-ups

```ts
import { ClaudeSession } from "@with-logic/elwood";

const session = new ClaudeSession({ cwd: process.cwd() });
try {
  console.log(await session.send("Summarize the test strategy."));
  console.log(await session.send("Which gaps would you address first?"));
} finally {
  await session.close();
}
```

`send()` combines observed assistant text messages with a blank line between them. It does not include thinking or tool output. Calls to `send()` and `stream()` on one session are serialized in call order. Separate sessions can run independently, but agents editing the same files still need coordination from your app.

## Streaming

Use `stream()` when your interface should show progress before the final reply. It yields four kinds of content event:

```ts
import { ClaudeSession } from "@with-logic/elwood";

const session = new ClaudeSession();
try {
  for await (const event of session.stream("Find the test entry points.")) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.text);
        break;
      case "thinking":
        // Display separately from the answer, if useful.
        break;
      case "tool_call":
        console.error(`Using ${event.name}`);
        break;
      case "tool_result":
        console.error(event.output ?? "Tool finished");
        break;
    }
  }
} finally {
  await session.close();
}
```

Tool call/result events include `toolCallId` when the adapter supplies it. Stream text arrives as observed messages; do not assume token-by-token delivery. Lifecycle, warnings and hooks belong to session event subscriptions, not this four-event content stream.

Breaking out of a stream stops consuming it; it does **not** cancel the underlying turn. Call `interrupt()` or close the session when you mean to stop the agent.

## Attach an image

Images are part of a turn. Keep the prompt specific about what the agent should inspect.

```ts
const reply = await session.send("Explain the layout issue in this screenshot.", {
  images: [{ path: "/absolute/path/to/screenshot.png" }],
  timeoutMs: 120_000,
});
```

Use readable local files. Multiple images preserve their order. [See the API reference](api.html#turn-options) for the turn options.

## Codex sessions

Use `CodexSession` with the same `send()`, `stream()` and `close()` pattern:

```ts
import { CodexSession } from "@with-logic/elwood";

const session = new CodexSession({ cwd: process.cwd() });
try {
  console.log(await session.send("Explain this project's build process."));
} finally {
  await session.close();
}
```

This starts a Codex conversation; it does not convert a running Claude conversation. Agent-specific constructor options and hooks differ.

## Startup and cleanup

Use `await session.start()` if you want startup to complete before the first prompt. It is idempotent; concurrent calls share the same startup. You can register event handlers before startup.

`close()` stops the process, with a kill fallback if graceful stopping fails. It does not delete Elwood's saved metadata. `teardown()` is the separate operation for removing Elwood-owned state. Neither operation reverses files the agent edited or deletes history owned by the agent CLI.

For shell-based continuation across processes, [use the default session retention and `--resume`](cli.html#resuming-a-session). For advanced TypeScript resume, `resumeClaude()` / `resumeCodex()` return the low-level session API. They do not return the ergonomic class, so do not assume they have `send()` or `stream()`.

## Timeouts and cancellation

A `send()` or `stream()` timeout rejects that call with `wait_timeout`. The agent may still be working. The next queued turn waits for the agent's actual turn boundary; a timeout does not make it safe to submit raw input concurrently.

Use `await session.interrupt()` to request an interruption. Keep cleanup in `finally`. Do not mix low-level `sendMessage()`, `sendPrompt()` or `sendGuidance()` with an in-flight ergonomic turn: those raw methods are not part of its turn queue.
