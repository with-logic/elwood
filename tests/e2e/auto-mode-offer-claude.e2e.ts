/**
 * Claude's auto-mode setup offer, which Claude paints right after a turn's Stop above a
 * composer that stays visible, blocks a named session. A caller's `sendMessage` made while
 * it is visible writes nothing to Claude, then submits once the offer is dismissed.
 * A headless `elwood run` whose turn the offer follows still succeeds.
 * Implements C-ATTN-09 (PRD §5.3) and C-CLI-05 (PRD §12A.2).
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { CliJsonlRecord } from "../../src/cli/output/types.ts";
import { isRecord } from "../../src/core/predicates.ts";
import { allStatusList } from "../../src/core/status-categories.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { offerSessionOptions, offerShown, seedOffer } from "./auto-mode-offer.ts";
import { invoke } from "./cli-commands-helpers.ts";
import {
  cleanup,
  e2eTimeoutMs,
  hookNamed,
  makeProject,
  observeSession,
  skipIf,
  skipNow,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";
import { holdCliOutput } from "./output-hold.ts";

/** A headless run can finish before the offer paints, which leaves nothing to check. */
const runAttempts = 3;
/** Long enough that a held message would have resolved (paste, 150 ms, Enter) had it gone out. */
const heldWindowMs = 3_000;

/** Every string Elwood writes to Claude in this process, in order; nothing is held. */
const writes: string[] = [];
holdCliOutput({ input: (data) => writes.push(data) });

/** A multi-line prompt of a few hundred characters, which Claude shows as a pasted pill. */
function reportShapedPrompt(marker: string): string {
  const filler = (n: number) =>
    `Line ${n} carries ordinary filler words so that the prompt has a realistic length.`;
  return [
    `Check ${marker}: please read all of these lines.`,
    filler(2),
    filler(3),
    filler(4),
    filler(5),
    "Reply with exactly OK and nothing else. Do not use tools.",
  ].join("\n");
}

test("C-ATTN-09 a sendMessage made while Claude's auto-mode offer shows is held, not lost", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: 240_000,
}, async (t) => {
  seedOffer();
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude(offerSessionOptions(project, "Offer Check"));
    const live = session;
    const observed = observeSession(live);
    const screen = () => live.terminal.snapshot().text;
    await waitFor(() => (live.status === "ready" ? true : undefined), "initial ready", 120_000);
    await live.sendMessage("Reply with exactly OK.");
    await waitFor(() => hookNamed(observed.hooks, "Stop"), "first turn Stop", 90_000);
    if (!(await offerShown(live))) {
      skipNow(t, `Claude did not offer auto-mode setup on this account:\n${screen()}`);
      return;
    }

    const marker = `zq${Date.now().toString(36)}`;
    const hooksBefore = observed.hooks.length;
    const submitted = () =>
      observed.hooks
        .slice(hooksBefore)
        .some(
          (hook) => hook.hook_event_name === "UserPromptSubmit" && hook.prompt.includes(marker),
        );
    const writesBefore = writes.length;
    let resolved = false;
    const sending = live.sendMessage(reportShapedPrompt(marker)).then(() => {
      resolved = true;
    });
    // Teardown rejects a still-held send if an assertion below fails first.
    void sending.catch(() => undefined);
    await delay(heldWindowMs);
    assert.equal(resolved, false, `the message was written into the offer:\n${screen()}`);
    assert.deepEqual(writes.slice(writesBefore), [], "nothing was written to the offer");
    assert.match(screen(), /❯ 1\. Yes/, "the offer's menu is unanswered");
    assert.doesNotMatch(screen(), /Space to toggle/, "no setup step opened");
    assert.equal(live.status, "blocked");
    assert.ok(
      observed.activities.some(
        (event) => event.kind === "attention" && event.label === "claude-auto-mode-offer",
      ),
      "the block names the offer rule",
    );

    // Dismissing the offer releases the held message as a normal turn.
    await live.sendKeys("\u001b");
    await sending;
    await waitFor(() => (submitted() ? true : undefined), "held message submitted", 30_000);
    await waitFor(
      () => hookNamed(observed.hooks.slice(hooksBefore), "Stop"),
      "held message turn Stop",
      90_000,
    );
    const pastes = writes.slice(writesBefore).filter((data) => data.includes(marker));
    const prompts = observed.hooks
      .slice(hooksBefore)
      .filter((hook) => hook.hook_event_name === "UserPromptSubmit");
    assert.equal(pastes.length, 1, "the message was pasted once, after the offer closed");
    assert.equal(prompts.length, 1, "the message was submitted once");
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

const knownStatuses: ReadonlySet<unknown> = new Set(allStatusList);
/** Every JSONL record type, so that a new one fails to compile here until it is listed. */
const jsonlTypes: Readonly<Record<CliJsonlRecord["type"], true>> = {
  text: true,
  thinking: true,
  tool: true,
  status: true,
  warning: true,
  result: true,
  error: true,
};
const isJsonlType = (type: unknown): type is CliJsonlRecord["type"] =>
  typeof type === "string" && Object.hasOwn(jsonlTypes, type);

/** One `--output=jsonl` line, checked, so that an unknown or malformed record fails. */
function jsonlRecord(line: string) {
  const record: unknown = JSON.parse(line);
  const type = isRecord(record) ? record["type"] : undefined;
  if (!(isRecord(record) && isJsonlType(type))) throw new Error(`Not a JSONL record: ${line}`);
  const status = record["status"];
  if (type === "status" && !knownStatuses.has(status))
    throw new Error(`Not a session status: ${line}`);
  return { type, status };
}

test("C-CLI-05 elwood run succeeds when Claude's auto-mode offer follows its prompt's turn", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: runAttempts * (e2eTimeoutMs + 30_000),
}, async (t) => {
  for (let attempt = 1; attempt <= runAttempts; attempt += 1) {
    seedOffer();
    const project = makeProject("claude");
    try {
      const result = await invoke(
        [
          "--agent=claude",
          `--state-dir=${project.stateDir}`,
          "--claude-permission-mode=auto",
          "--model=haiku",
          "--output=jsonl",
          "--timeout=3m",
          "Reply with exactly OK.",
        ],
        project.cwd,
      );
      const records = result.stdout.trim().split("\n").map(jsonlRecord);
      const last = records.at(-1);
      assert.equal(last?.type, "result", `the run failed:\n${result.stdout}\n${result.stderr}`);
      assert.equal(result.status, 0);
      const statuses = records.flatMap((record) =>
        record.type === "status" ? [record.status] : [],
      );
      const turnEnded = statuses.indexOf("ready", statuses.indexOf("running"));
      if (turnEnded >= 0 && statuses.includes("blocked", turnEnded)) return;
    } finally {
      rmSync(project.cwd, { recursive: true, force: true });
    }
  }
  skipNow(t, `Claude did not paint the offer before any of ${runAttempts} runs finished`);
});
