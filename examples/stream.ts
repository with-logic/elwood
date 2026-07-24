/**
 * Ergonomic streaming: watch a turn's typed events — thinking, tool calls/results, and
 * assistant text — as they arrive, instead of waiting for the final string (PRD §5.8).
 * `send` is just this generator drained for text; `stream` is the same turn, live.
 */

import { ClaudeSession } from "../src/index.ts";

const session = new ClaudeSession({ autotrust: true });
try {
  for await (const event of session.stream("List the files here, then summarize the project.")) {
    switch (event.type) {
      case "thinking":
        process.stderr.write(`  (thinking) ${event.text}\n`);
        break;
      case "tool_call":
        process.stdout.write(`→ ${event.name}${event.input ? ` ${event.input}` : ""}\n`);
        break;
      case "tool_result":
        process.stdout.write(`← ${event.output ?? ""}\n`);
        break;
      case "text":
        process.stdout.write(event.text);
        break;
    }
  }
  process.stdout.write("\n");
} finally {
  await session.close();
}
