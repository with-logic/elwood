/**
 * Launches several fresh, untrusted Claude folders with `autotrust` at once, the way
 * Coal Harbor starts agents, and requires every one to clear the REAL folder-trust gate
 * and reach `ready`. Concurrent launches load the machine, which is when Claude's trust
 * dialog resets its selection to "No, exit" as its input guard settles; an Enter that
 * travelled without its own absolute selection then exits the CLI with code 1.
 * Implements C-E2E-09 for C-CLAUDE-10 and C-TRUST-01 (§5.1, §5.4).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";
import { folderTrustScreenVisible } from "./trust-screens.ts";

const launches = 5;
const home = "\u001b[H";

test("C-E2E-09 concurrent fresh-folder autotrust launches all clear the REAL Claude trust gate", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async (t) => {
  const writes: string[][] = [];
  const sessions: ClaudeSessionApi[] = [];
  const exits: number[] = [];
  t.after(async () => {
    try {
      await Promise.all(sessions.map((session) => cleanup(session)));
    } finally {
      resetRuntimeSeamsForTests();
    }
  });
  // Delegate to the real PTY; record every physical write each session makes.
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    const recorded: string[] = [];
    writes.push(recorded);
    return {
      ...pty,
      write(data) {
        pty.write(data);
        recorded.push(typeof data === "string" ? data : Buffer.from(data).toString());
      },
    };
  });
  const started = await Promise.all(
    Array.from({ length: launches }, async () => {
      const project = makeProject("claude");
      const session = await startClaude({
        cwd: project.cwd,
        stateDir: project.stateDir,
        autotrust: true,
      });
      sessions.push(session);
      session.on("activity", (event) => {
        if (event.kind === "terminal_exit" && event.exitCode !== undefined)
          exits.push(event.exitCode);
      });
      return session;
    }),
  );
  await Promise.all(
    started.map((session, index) =>
      waitFor(
        () => {
          if (session.status === "exited") throw new Error(`launch ${index} exited at its gate`);
          if (session.status !== "ready") return undefined;
          return folderTrustScreenVisible(session.terminal.snapshot().text) ? undefined : true;
        },
        `autotrust launch ${index} clears the folder-trust gate and reaches ready`,
        120_000,
      ),
    ),
  );
  assert.deepEqual(exits, [], "no launch exited at its trust gate");
  const trustKeys = writes
    .flat()
    .filter((input) => ["\r", "\u001b[A", "\u001b[B"].some((key) => input.includes(key)));
  assert.ok(trustKeys.length >= launches, "every launch answered a real trust gate");
  for (const input of trustKeys) {
    // A relative arrow or bare Enter is decided from a frame the CLI may already have
    // reset; every trust key carries its own absolute selection.
    assert.ok(input.startsWith(home), `trust write ${JSON.stringify(input)} is absolute`);
  }
});
