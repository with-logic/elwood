/**
 * Keys a caller types while Elwood is answering Codex's trust gate must never be submitted
 * by that answer's retry. Under load Codex takes the answer but its next screen reaches
 * Elwood late, so the gate Elwood still sees is stale and its retry would land in Codex's
 * composer after the caller's keys. The test makes that lag certain by holding the CLI's
 * output from Elwood for four seconds once the answer is written, while Codex itself runs
 * normally, and types as soon as Codex's own output shows its composer. The session uses a bogus model, so a
 * stray submission is refused before using quota. The launch must show and answer the real
 * gate, or the run skips loudly. Covers C-TRUST-01 (§5.4).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createCliSanitizer } from "../../src/cli/output/sanitize.ts";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { stopCodex } from "./codex-ready.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipNow,
  skipReason,
  waitFor,
} from "./helpers.ts";
import { trustPromptVisible } from "./trust-screens.ts";

const bogusModel = "gpt-elwood-nonexistent-model";
/** Long enough for Codex to take a retried answer while Elwood still sees its gate. */
const lagMs = 4_000;
/** How long after the lag a stray submission has to show itself. */
const settleMs = 5_000;
/** Codex draws spaces as cursor moves, so raw output is matched without them. */
const directoryTrustOutput = /trustthisfolder\?|trustthecontentsofthisdirectory/i;
/** Codex's configured composer: its footer names the session's model. */
const composerOutput = new RegExp(bogusModel);

type Launch = {
  displayed: boolean;
  answered: boolean;
  readonly writes: string[];
  /** Settles once Codex, unseen by Elwood, has drawn its composer after the answer. */
  readonly composer: PromiseWithResolvers<void>;
};

/**
 * Records the launch's writes. Elwood sees no output for `lagMs` after the first trust
 * answer; the raw output it is not shown reveals when Codex has taken the answer.
 */
function lagAfterAnswer(): Launch {
  const launch: Launch = {
    displayed: false,
    answered: false,
    writes: [],
    composer: Promise.withResolvers<void>(),
  };
  const plainText = createCliSanitizer();
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    const handlers = new Set<(data: string) => void>();
    let held: string[] | undefined;
    let output = "";
    let afterAnswer = "";
    pty.onData((data) => {
      if (!launch.displayed) {
        output += data;
        launch.displayed = directoryTrustOutput.test(plainText(output).replace(/\s+/g, ""));
      }
      if (held === undefined) for (const handler of handlers) handler(data);
      else {
        held.push(data);
        afterAnswer += data;
        if (composerOutput.test(plainText(afterAnswer))) launch.composer.resolve();
      }
    });
    return {
      ...pty,
      onData(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      write(data) {
        pty.write(data);
        if (typeof data === "string") launch.writes.push(data);
        if (data !== "1\r" || launch.answered) return;
        launch.answered = true;
        held = [];
        setTimeout(() => {
          const chunks = held ?? [];
          held = undefined;
          for (const chunk of chunks) for (const handler of handlers) handler(chunk);
        }, lagMs);
      },
    };
  });
  return launch;
}

test("C-TRUST-01 keys a caller types during Codex's trust answer are never submitted by it", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 180_000,
}, async (t) => {
  const project = makeProject("codex");
  execFileSync("git", ["init", "-q", project.cwd]);
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const launch = lagAfterAnswer();
  let session: CodexSessionApi | undefined;
  t.after(async () => {
    try {
      if (session !== undefined) await stopCodex(session);
    } finally {
      resetRuntimeSeamsForTests();
      sandbox.dispose();
    }
  });
  session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    model: bogusModel,
    autotrust: true,
  });
  const live = session;
  const submitted: string[] = [];
  live.on("hook", (event) => {
    if (event.hook_event_name === "UserPromptSubmit") submitted.push(JSON.stringify(event));
  });
  let finished = false;
  const ended = waitFor(
    () => (finished ? "done" : live.status === "exited" ? "exited" : undefined),
    "Codex's composer behind its answered gate",
    120_000,
  ).catch(() => "timeout");
  const outcome = await Promise.race([launch.composer.promise.then(() => "composer"), ended]);
  finished = true;
  const screen = () => live.terminal.snapshot().text;
  assert.notEqual(outcome, "exited", `Codex exited:\n${screen()}`);
  if (!launch.displayed) {
    skipNow(t, `Codex showed no directory-trust prompt (auto-trusted or reworded):\n${screen()}`);
    return;
  }
  assert.equal(outcome, "composer", `Codex never took the answer:\n${screen()}`);
  // Codex is at its composer; Elwood, its output held, still sees the gate.
  assert.ok(trustPromptVisible(screen(), "codex"), `Elwood's view trails Codex:\n${screen()}`);
  const typedAt = launch.writes.length;
  await live.sendKeys("hello");
  await new Promise((resolve) => setTimeout(resolve, lagMs + settleMs));
  const after = launch.writes.slice(typedAt);
  t.diagnostic(`writes: ${JSON.stringify(launch.writes)}`);
  assert.deepEqual(after, ["hello"], "nothing was written after the caller's keys");
  const stray = submitted.filter((event) => event.includes("hello"));
  assert.deepEqual(stray, [], "the caller's keys were not submitted");
  assert.match(screen(), /^› hello\s*$/m, `the caller's draft stays in the composer:\n${screen()}`);
});
