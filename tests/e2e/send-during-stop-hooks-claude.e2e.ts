/**
 * Real Claude readiness for a send made while a slow user `Stop` hook runs (PRD §6.5, C-HOOK-24).
 * Elwood's own `Stop` hook reports `ready` while the user's hook still runs. Claude queues a send
 * made then and fires its `UserPromptSubmit` under the previous turn's prompt ID. That send
 * starts a new turn, not guidance for the turn that ended, so its `Stop` must not be held.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type ElwoodWarningEvent, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";

const options = { skip: skipIf(skipReason("claude"), skipTurns), timeout: 240_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "C-HOOK-24 real Claude holds no Stop for a send made while a user Stop hook runs",
  options,
  async () => {
    const project = makeProject("claude");
    mkdirSync(join(project.cwd, ".claude"), { recursive: true });
    const stopHook = [{ hooks: [{ type: "command", command: "sleep 4", timeout: 60 }] }];
    writeFileSync(
      join(project.cwd, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: stopHook } }),
    );
    const session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      permissionMode: "bypassPermissions",
      autotrust: true,
    });
    let stops = 0;
    const submitIds: (string | undefined)[] = [];
    const readyAfterStops: number[] = [];
    const warnings: ElwoodWarningEvent["code"][] = [];
    try {
      session.on("hook", (event) => {
        const id = event["prompt_id"];
        if (event.hook_event_name === "UserPromptSubmit")
          submitIds.push(typeof id === "string" ? id : undefined);
        if (event.hook_event_name === "Stop") stops += 1;
      });
      session.on("warning", (warning) => void warnings.push(warning.code));
      await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
      session.on("status", (event) => {
        if (event.status === "ready") readyAfterStops.push(stops);
      });
      await session.sendMessage("Reply with the single word: one. Do not use tools.");
      const readyAt = (n: number) => () =>
        stops >= n && session.status === "ready" ? true : undefined;
      await waitFor(readyAt(1), "ready after the first Stop", 90_000);
      await session.sendMessage("Reply with the single word: two. Do not use tools.");
      await waitFor(readyAt(2), "ready after the second Stop", 120_000);
      await sleep(3_000);
      assert.equal(submitIds.length, 2, "one submit per send");
      assert.equal(submitIds[1], submitIds[0], "the second send reuses the first turn's prompt ID");
      assert.equal(stops, 2, "each send runs its own turn");
      assert.deepEqual(readyAfterStops, [1, 2]);
      const held = session
        .statusDecisions()
        .filter((decision) => decision.evidence === "hook_turn_ended" && decision.to === undefined);
      assert.deepEqual(held, [], "the second send started a new turn, so no Stop was held");
      assert.deepEqual(warnings, []);
    } finally {
      await cleanup(session);
    }
  },
);
