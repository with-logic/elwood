/** Native submission/work prevents all subsequent recovery Enter attempts (C-API-31). */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import { codexScreenFactTable } from "../../src/codex/screen-table.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { currentRenderedFrame } from "../../src/terminal/cursor.ts";
import type { TerminalSnapshot } from "../../src/terminal/headless.ts";
import {
  cleanup,
  codexAuthMissing,
  type E2eSession,
  makeProject,
  observeSession,
  prepareInteractivePrompt,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-31 ${agent} native submission/work permits no recovery Enter`, {
    skip: skipIf(skipReason(agent), agent === "codex" ? codexAuthMissing() : undefined),
    timeout: 150_000,
  }, async (t) => {
    const project = makeProject(agent);
    const sandbox =
      agent === "codex"
        ? sandboxedCodexHome(
            project,
            'check_for_update_on_startup = false\n[tui]\nstatus_line = ["model-with-reasoning"]\n',
          )
        : undefined;
    let session: E2eSession | undefined;
    let armed = false;
    let resuming = false;
    let submitted = false;
    let attemptsAfterSubmission = 0;
    let phaseStarted = 0;
    let timeline: { event: string; ms: number }[] = [];
    let lastFrame: TerminalSnapshot | undefined;
    let attempted = 0;
    let delivered = 0;
    setPtyFactoryForTests((options) => {
      // The public resume options omit model; keep this probe quota-independent
      // by appending the same invalid native --model flag at the PTY launch seam.
      assert.deepEqual(options.args.slice(0, 3), ["-l", "-i", "-c"]);
      const pty = nodePtyFactory({
        ...options,
        args: options.args.map((value, index) =>
          resuming && index === options.args.length - 1
            ? `${value} --model gpt-elwood-nonexistent-acceptance-probe`
            : value,
        ),
      });
      return {
        ...pty,
        write(data) {
          if (armed && String(data) === "\r") {
            attempted += 1;
            timeline.push({ event: "Enter", ms: Date.now() - phaseStarted });
            // Count every retry before interception; even a pre-hook attempt must fail.
            if (attempted > 1) {
              if (submitted) attemptsAfterSubmission += 1;
              throw new Error("Native proof intercepted an extra Enter.");
            }
            lastFrame = session ? currentRenderedFrame(session.terminal) : undefined;
            delivered += 1;
          }
          pty.write(data);
        },
      };
    });
    try {
      // Both native CLIs reject this model before consuming model quota.
      session = await (agent === "claude" ? startClaude : startCodex)({
        cwd: project.cwd,
        stateDir: project.stateDir,
        autotrust: true,
        autoupdate: false,
        initialSize: { cols: 140, rows: 35 },
        model: "gpt-elwood-nonexistent-acceptance-probe",
      });
      for (const phase of ["cold", "resume"] as const) {
        if (phase === "resume") {
          const id: string = session.elwoodSessionId;
          await session.stop();
          armed = false;
          resuming = true;
          session = await (agent === "claude" ? resumeClaude : resumeCodex)({
            cwd: project.cwd,
            stateDir: project.stateDir,
            elwoodSessionId: id,
            autotrust: true,
            autoupdate: false,
            initialSize: { cols: 140, rows: 35 },
          });
        }
        attempted = 0;
        delivered = 0;
        const live = session;
        const observed = observeSession(live);
        let workingFrames = 0;
        let timer: ReturnType<typeof setInterval> | undefined;
        const read = () => {
          const frame = currentRenderedFrame(live.terminal);
          if (!armed || delivered === 0 || !frame || frame === lastFrame) return;
          lastFrame = frame;
          const { facts } = readScreenFacts(
            agent === "claude" ? claudeScreenFactTable : codexScreenFactTable,
            { text: frame.text, title: live.terminal.title },
          );
          if (facts.working_visible) workingFrames += 1;
        };
        const source: {
          on(event: "activity", listener: (event: ElwoodActivityEvent) => void): () => void;
        } = live;
        const unsubscribe = source.on("activity", (event) => {
          if (event.kind === "user_message") {
            submitted = true;
            timeline.push({ event: "user_message", ms: Date.now() - phaseStarted });
          }
        });
        try {
          await prepareInteractivePrompt(live, observed, agent);
          await waitFor(
            () => (live.status === "ready" ? true : undefined),
            `${agent} ready`,
            30_000,
          );
          submitted = false;
          attemptsAfterSubmission = 0;
          phaseStarted = Date.now();
          timeline = [];
          timer = setInterval(read, 10);
          armed = true;
          await live.sendMessage("Reply only OK.");
          await waitFor(
            () =>
              observed.activities.some((event) => event.kind === "user_message") &&
              workingFrames > 0
                ? true
                : undefined,
            `${agent} native submission evidence`,
            15_000,
          );
          await delay(6_000);
          const userHooks = observed.hooks.filter(
            (event) => event.hook_event_name === "UserPromptSubmit",
          ).length;
          t.diagnostic(
            JSON.stringify({
              agent,
              phase,
              attempted,
              delivered,
              userHooks,
              workingFrames,
              attemptsAfterSubmission,
              timeline,
            }),
          );
          assert.equal(userHooks, 1);
          assert.equal(attemptsAfterSubmission, 0);
          assert.equal(attempted, 1);
          assert.equal(delivered, 1);
        } finally {
          clearInterval(timer);
          unsubscribe();
          observed.dispose();
        }
      }
    } finally {
      await cleanup(session);
      sandbox?.dispose();
      resetRuntimeSeamsForTests();
    }
  });
}
