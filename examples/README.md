# Elwood Examples

## Minimal — ask and answer (`minimal.ts`)

The smallest possible use of Elwood. Construct a session, `send` a message, get the
assistant's reply back as a string, ask a follow-up. The session starts lazily on the
first `send`, so there is no start ceremony and no manual "wait for ready".

```sh
npm run example:minimal
```

```ts
const session = new SimpleCodexSession({ autotrust: true });
const joke = await session.send("Tell me a joke that involves a dog.");
const rewrite = await session.send("Now rewrite it to be about a cat.");
await session.close();
```

## Streaming — watch the work (`stream.ts`)

When you want the intermediate steps, `stream` yields typed events — `thinking`,
`tool_call`, `tool_result`, `text` — as they arrive. `send` is just this generator
drained for the `text`, so the two share one turn boundary.

```sh
npm run example:stream
```

```ts
for await (const event of session.stream("List the files, then summarize the project.")) {
  if (event.type === "text") process.stdout.write(event.text);
  // event.type is also "thinking" | "tool_call" | "tool_result"
}
```

## Full — the raw control surface (`full.ts`)

`full.ts` drops below the ergonomic facade to the low-level API: `startClaude`/
`startCodex`, raw `activity`/`warning`/`terminal:exit` events, explicit
`waitForStatus`, and CLI flags for agent/cwd/prompt/timeout. Reach for this when you
need full control over the session lifecycle; most callers want `send`/`stream` above.

```sh
npm run example:full
npm run example:full -- --agent codex --cwd . --prompt "Summarize this repo in one paragraph."
npm run example:full -- --agent claude --cwd . --prompt "Summarize this repo in one paragraph."
```

All examples use `autotrust: true` so embedded sessions can move past known workspace
trust prompts. The package scripts run the TypeScript examples under a small Node
supervisor because `node-pty` owns real PTYs more reliably there and the supervisor can
kill the example process tree on Ctrl-C.
