/**
 * A long multi-line persona must actually submit and start a turn.
 * Implements C-API-31 (paste+Enter race), C-E2E-02, and C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startClaude, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, turnsEnabled, waitFor } from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

// 18 lines, mirroring coal-harbor's preamble+persona shape that reliably
// reproduced the staged-but-unsubmitted composer.
const persona = [
  "You are a terse assistant embedded in a product.",
  ...Array.from({ length: 15 }, (_, i) => `Persona rule ${i + 1}: stay concise and factual.`),
  "When asked anything in this session, reply exactly: ELWOOD_PERSONA_OK.",
  "Do not use tools.",
].join("\n");

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-31 real ${agent} submits an 18-line persona as the first turn`, {
    skip: skipReason(agent) ?? skipTurnsReason,
    timeout: 240_000,
  }, async () => {
    const project = makeProject(agent);
    const prompts: string[] = [];
    let stops = 0;
    const onPrompt = (event: { readonly prompt: string }) => {
      prompts.push(event.prompt);
      return undefined;
    };
    const onStop = () => {
      stops += 1;
      return undefined;
    };
    const common = {
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      persona,
    };
    const session =
      agent === "claude"
        ? await startClaude({
            ...common,
            permissionMode: "bypassPermissions",
            hooks: { UserPromptSubmit: onPrompt, Stop: onStop },
          })
        : await startCodex({
            ...common,
            sandbox: "read-only",
            approvalPolicy: "never",
            hooks: { UserPromptSubmit: onPrompt, Stop: onStop },
          });
    try {
      // The race left the persona staged forever; submission means the CLI
      // actually accepted the turn — proven by the prompt hook and Stop.
      await waitFor(
        () => (prompts.some((p) => p.includes("ELWOOD_PERSONA_OK")) ? true : undefined),
        "persona UserPromptSubmit",
        90_000,
      );
      await waitFor(() => (stops > 0 ? true : undefined), "persona turn Stop", 120_000);
      assert.ok(prompts[0]?.includes("Persona rule 15"), "full multi-line persona submitted");
    } finally {
      await cleanup(session);
    }
  });
}
