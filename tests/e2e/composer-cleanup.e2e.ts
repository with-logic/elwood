/** Native cancelled image/text drafts clear without submitting a model turn (C-API-44/56). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { imageChipCount } from "../../src/core/images/chip-wait.ts";
import { cancellableSubmission } from "../../src/core/input/submission-cancel.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
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
const chip = /\[Image #\d+\]/;
const markers = ["ELWOOD_CANCELLED_DRAFT", "ELWOOD_SUCCESSOR_DRAFT"] as const;
const clear = "\u0015\u000b";
for (const agent of ["claude", "codex"] as const) {
  test(`C-API-44/56 ${agent} cancels an actual session image draft before its queued successor attaches`, {
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
    const aborts = [new AbortController(), new AbortController()];
    const writes: string[] = [];
    let session: E2eSession | undefined;
    let armed = false;
    let attachments = 0;
    setPtyFactoryForTests((options) => {
      const pty = nodePtyFactory(options);
      return {
        ...pty,
        write(data) {
          const text = String(data);
          if (armed) {
            if (text === "\r") {
              assert.ok(writes.some((write) => write.includes(markers[1])));
              aborts[1]!.abort();
              throw new Error("Native proof withholds the successor Enter.");
            }
            if (text === "\u0016" || text.includes(image)) {
              attachments += 1;
              if (attachments === 2) {
                const screen = session!.terminal.snapshot().text;
                t.diagnostic(
                  JSON.stringify({
                    agent,
                    phase: "successor-image",
                    composerChips: imageChipCount(screen),
                    cleanupSent: writes.includes(clear),
                  }),
                );
                assert.ok(writes.includes(clear), "cleanup precedes the successor image write");
              }
            }
            const draft = markers.findIndex((marker) => text.includes(marker));
            if (draft >= 0) {
              const screen = session!.terminal.snapshot().text;
              t.diagnostic(
                JSON.stringify({
                  agent,
                  phase: `draft-${draft}`,
                  composerChips: imageChipCount(screen),
                  viewportChips: [...screen.matchAll(/\[Image #\d+\]/g)].length,
                }),
              );
              assert.equal(imageChipCount(screen), 1);
              if (draft === 1)
                assert.equal(
                  screen.includes(markers[0]),
                  false,
                  "old draft is gone before successor text",
                );
            }
            writes.push(text);
            pty.write(data);
            // The first cancellation races native paste consumption; the successor cancels
            // at its guarded Enter boundary after exercising the real queued attachment.
            if (draft === 0) aborts[0]!.abort();
          } else pty.write(data);
        },
      };
    });
    t.after(resetRuntimeSeamsForTests);
    session = await (agent === "claude" ? startClaude : startCodex)({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
    });
    const live = session;
    const observed = observeSession(live);
    const diagnose = (phase: "cancelled" | "failure") => {
      const screen = live.terminal.snapshot().text;
      t.diagnostic(
        JSON.stringify({
          agent,
          phase,
          status: live.status,
          markerPresent: markers.some((marker) => screen.includes(marker)),
          chipPresent: chip.test(screen),
          attachments,
          cleanupWrites: writes.filter((write) => write === clear).length,
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
      armed = true;
      // Both calls use the session's real image queue, cleanup owner and private cancellation seam.
      const submissions = markers.map((marker, index) =>
        assert.rejects(
          live.sendMessage(
            marker,
            cancellableSubmission({ images: [{ path: image }] }, aborts[index]!.signal),
          ),
          /Turn recovery cancelled/,
        ),
      );
      await Promise.all(submissions);
      assert.equal(attachments, 2);
      const clears = writes.filter((write) => write === clear).length;
      assert.ok(
        clears === 2 || clears === 3,
        "a retained first clear may retry before the successor",
      );
      await waitFor(
        () => {
          const screen = live.terminal.snapshot().text;
          return markers.some((marker) => screen.includes(marker)) || chip.test(screen)
            ? undefined
            : true;
        },
        `${agent} cancelled draft and image removed`,
        5_000,
      );
      assert.equal(
        observed.hooks.some((event) => event.hook_event_name === "UserPromptSubmit"),
        false,
      );
      diagnose("cancelled");
      if (clipboard) assert.deepEqual(execFileSync("/usr/bin/pbpaste"), clipboard);
    } catch (error) {
      diagnose("failure");
      throw error;
    } finally {
      for (const abort of aborts) abort.abort();
      observed.dispose();
      await cleanup(session);
    }
  });
}
