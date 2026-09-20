/** Native cancelled image/text drafts clear without submitting a model turn (C-API-44/56). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { attachClaudeImages } from "../../src/claude/attach-images.ts";
import { attachCodexImages } from "../../src/codex/images/attach.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { ComposerCleanup } from "../../src/core/input/composer-cleanup.ts";
import { queuedInputSubmitter } from "../../src/core/input/index.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  observeSession,
  prepareInteractivePrompt,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

const fixture = join(import.meta.dirname, "..", "fixtures", "sample.png");
const chip = /\[Image #\d+\]/;
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
    t.after(() => {
      sandbox?.dispose();
      if (clipboard) execFileSync("/usr/bin/pbcopy", { input: clipboard });
    });
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
    });
    const observed = observeSession(session);
    const closing = new AbortController();
    let queue: ControlQueue | undefined;
    try {
      t.diagnostic(`${agent}: ${execFileSync(agent, ["--version"], { encoding: "utf8" }).trim()}`);
      await prepareInteractivePrompt(session, observed, agent);
      await waitFor(
        () => (session.status === "ready" ? true : undefined),
        `${agent} idle readiness`,
        30_000,
      );
      const abort = new AbortController();
      const cancelled = new Error("cancel native staged draft");
      const marker = "ELWOOD_CANCELLED_DRAFT";
      const terminal = {
        snapshot: () => session.terminal.snapshot(),
        settled: () => session.terminal.settled(),
        get renderFailed() {
          return session.terminal.renderFailed;
        },
        async sendInput(data: string | Uint8Array) {
          const text = String(data);
          assert.notEqual(text, "\r", "this native proof must never submit a model turn");
          if (text === "\u0015\u000b")
            t.diagnostic(
              `staged: ${session.terminal
                .snapshot()
                .text.split("\n")
                .find((line) => line.includes(marker))}`,
            );
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
      const owner = new ComposerCleanup(
        terminal,
        () => false,
        closing.signal,
        () => closing.signal,
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
    } catch (error) {
      t.diagnostic(session.terminal.snapshot().text);
      throw error;
    } finally {
      closing.abort();
      queue?.close();
      observed.dispose();
      await cleanup(session);
    }
  });
}
