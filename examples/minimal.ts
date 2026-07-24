/**
 * The smallest Elwood example: ask a question, get the answer, ask a follow-up.
 * The ergonomic facade starts Codex lazily on the first `send` and gives back the
 * assistant's text as a string (PRD §5.8).
 */

import { SimpleCodexSession } from "../src/index.ts";

const session = new SimpleCodexSession({ autotrust: true });
try {
  process.stdout.write(`${await session.send("Tell me a joke that involves a dog.")}\n`);
  process.stdout.write(`${await session.send("Now rewrite it to be about a cat.")}\n`);
} finally {
  await session.close();
}
