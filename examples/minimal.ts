/**
 * Smallest practical Elwood example: start Codex headlessly, send one message,
 * observe structured activity, and stop the session.
 */

import { startCodex } from "../src/index.ts";
import { cleanupSession, waitForSettled } from "./support.ts";

const session = await startCodex({ cwd: process.cwd(), autotrust: true });

try {
  process.stdout.write(`started ${session.elwoodSessionId}\n`);
  session.on("activity", (event) => {
    process.stdout.write(`${event.kind}: ${event.text ?? event.label}\n`);
  });
  await session.sendMessage("Hello!");
  if (!(await waitForSettled(session, 90_000))) {
    throw new Error("Timed out waiting for Codex to finish.");
  }
} finally {
  if (session.status !== "exited") await cleanupSession(session);
}
