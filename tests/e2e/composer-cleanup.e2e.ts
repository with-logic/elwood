/** Native cancelled image/text drafts clear without submitting a model turn (C-API-44/56). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { attachClaudeImages } from "../../src/claude/attach-images.ts";
import { liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { attachCodexImages } from "../../src/codex/images/attach.ts";
import { liveCodexClearance } from "../../src/codex/screen/live-clearance.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { ComposerCleanup } from "../../src/core/input/composer-cleanup.ts";
import { queuedInputSubmitter } from "../../src/core/input/index.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { currentRenderedFrame } from "../../src/terminal/cursor.ts";
import { codexLaunches, endCodexTestAfter } from "./codex-test-end.ts";
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

const fixture = join(import.meta.dirname, "..", "fixtures", "sample.png");

/**
 * Codex saves each image pasted into its composer as a copy in its temp dir and never
 * removes it, and nothing names the copy of a draft that is never submitted, so Elwood does
 * not remove it either (`docs/cli-behavior.md`). This Codex keeps its temp files in its
 * sandbox home, which goes with the sandbox. Returns that temp dir.
 */
function useCodexTempDirIn(home: string): string {
  const dir = join(home, "tmp");
  mkdirSync(dir);
  setPtyFactoryForTests((options) =>
    nodePtyFactory({ ...options, env: { ...options.env, TMPDIR: `${dir}/` } }),
  );
  return dir;
}
const chip = /\[Image #\d+\]/;
const marker = "ELWOOD_CANCELLED_DRAFT";
for (const agent of ["claude", "codex"] as const) {
  test(`C-API-44/56 ${agent} cancels a native image/text draft without a turn`, {
    skip: skipIf(
      skipReason(agent),
      agent === "codex" && process.platform !== "darwin" && "Codex images require macOS",
      agent === "codex" ? codexAuthMissing() : undefined,
    ),
    timeout: 120_000,
  }, async (t) => {
    const project = makeProject(agent);
    const image = join(project.cwd, "shot.png");
    copyFileSync(fixture, image);
    const sandbox = agent === "codex" ? sandboxedCodexHome(project, "") : undefined;
    const clipboard = agent === "codex" ? execFileSync("/usr/bin/pbpaste") : undefined;
    const launches = codexLaunches();
    let started: E2eSession | undefined;
    t.after(async () => {
      try {
        // Codex's sandbox stays, with the project, unless its Codex is confirmed gone.
        if (sandbox) await endCodexTestAfter(t, { sessions: [started], sandbox, launches });
        else await cleanup(started);
      } finally {
        resetRuntimeSeamsForTests();
        if (clipboard) execFileSync("/usr/bin/pbcopy", { input: clipboard });
      }
    });
    const codexTemp = sandbox ? useCodexTempDirIn(sandbox.home) : undefined;
    const options = { cwd: project.cwd, stateDir: project.stateDir, autotrust: true };
    const session: E2eSession = await (agent === "claude"
      ? startClaude(options)
      : launches.track(startCodex(options)));
    started = session;
    const observed = observeSession(session);
    const closing = new AbortController();
    let queue: ControlQueue | undefined;
    const diagnose = (phase: "staged" | "failure") => {
      const screen = session.terminal.snapshot().text;
      t.diagnostic(
        JSON.stringify({
          agent,
          phase,
          status: session.status,
          markerPresent: screen.includes(marker),
          chipPresent: chip.test(screen),
        }),
      );
    };
    try {
      await prepareInteractivePrompt(session, observed, agent);
      await waitFor(
        () => (session.status === "ready" ? true : undefined),
        `${agent} idle readiness`,
        30_000,
      );
      const abort = new AbortController();
      const cancelled = new Error("cancel native staged draft");
      const terminal = {
        snapshot: () => session.terminal.snapshot(),
        settled: () => session.terminal.settled(),
        get renderFailed() {
          return session.terminal.renderFailed;
        },
        async sendInput(data: string | Uint8Array) {
          const text = String(data);
          assert.notEqual(text, "\r", "this native proof must never submit a model turn");
          if (text === "\u0015\u000b") diagnose("staged");
          await session.terminal.sendInput(data);
          if (text.includes(marker)) {
            await waitFor(
              () => {
                const screen = session.terminal.snapshot().text;
                return screen.includes(marker) && chip.test(screen) ? true : undefined;
              },
              `${agent} rendered image and text draft`,
              10_000,
            );
            abort.abort(cancelled);
          }
        },
      };
      const isEmpty = (agent === "claude" ? liveClaudeClearance : liveCodexClearance)(
        () => session.terminal,
      );
      const owner = new ComposerCleanup(
        terminal,
        () => false,
        closing.signal,
        () => closing.signal,
        () => {
          const frame = currentRenderedFrame(session.terminal);
          return frame && isEmpty(frame.text) ? frame : undefined;
        },
      );
      queue = new ControlQueue(
        queuedInputSubmitter(terminal, {
          snapshot: () => terminal.snapshot().text,
          staged: () => false,
        }),
        () => new Error("closed"),
        () => undefined,
        () => false,
        undefined,
        (work, signal) => owner.run(work, signal),
      );
      queue.markReady();
      const attach = agent === "claude" ? attachClaudeImages : attachCodexImages;
      await assert.rejects(
        queue.send(marker, "prompt", (signal) => attach(terminal, [image], signal), {
          cancel: { signal: abort.signal, error: () => cancelled },
        }),
        (error) => error === cancelled,
      );
      await waitFor(
        () => {
          const screen = session.terminal.snapshot().text;
          return screen.includes(marker) || chip.test(screen) ? undefined : true;
        },
        `${agent} cancelled draft and image removed`,
        5_000,
      );
      assert.equal(
        observed.hooks.some((event) => event.hook_event_name === "UserPromptSubmit"),
        false,
      );
      if (clipboard) assert.deepEqual(execFileSync("/usr/bin/pbpaste"), clipboard);
      // The cancelled draft's copy is in the sandbox's temp dir, which goes with the sandbox.
      if (codexTemp) {
        const copies = readdirSync(codexTemp).filter((name) => name.startsWith("codex-clipboard-"));
        assert.equal(copies.length, 1, "Codex saved the pasted image in the sandbox's temp dir");
      }
    } catch (error) {
      diagnose("failure");
      throw error;
    } finally {
      closing.abort();
      queue?.close();
      observed.dispose();
    }
  });
}
