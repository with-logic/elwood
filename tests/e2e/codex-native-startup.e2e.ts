/** Native trust and MCP warning layouts, with real writes and no model turn (C-E2E-09/C-CODEX-15). */
import assert from "node:assert/strict";
import test from "node:test";
import { codexWarningsFromText } from "../../src/codex/startup-prompts.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { nativeCodex, unauthenticatedMcp } from "./codex-native-startup-harness.ts";
import { codexAuthMissing, skipIf, skipReason, waitFor } from "./helpers.ts";

test("C-E2E-09 real Codex trust gates clear and native MCP login warnings retain recovery", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 90_000,
}, async (t) => {
  const mcp = await unauthenticatedMcp();
  let native: ReturnType<typeof nativeCodex> | undefined;
  const responder = new TrustPromptResponder("codex", true);
  try {
    native = nativeCodex(mcp.url);
    const active = native;
    // Independent raw-frame predicates prevent a false-negative production parser
    // from making this test believe that a still-visible native gate has cleared.
    const directory = await waitFor(
      () => {
        const frame = active.frame();
        return /Do you trust the contents of this directory\?/.test(frame) &&
          /Yes, continue/.test(frame)
          ? frame
          : undefined;
      },
      "native directory trust options",
      25_000,
    );
    await answer(directory, "workspace_trust", "1\r");
    const hooks = await waitFor(
      () => {
        const frame = active.frame();
        return /Hooks need review/.test(frame) && /Trust all and continue/.test(frame)
          ? frame
          : undefined;
      },
      "native hook trust options",
      25_000,
    );
    assert.doesNotMatch(hooks, /Do you trust the contents of this directory\?/);
    await answer(hooks, "hook_trust", "2\r");
    await waitFor(
      () => {
        const frame = active.frame();
        return /OpenAI Codex \(v/.test(frame) &&
          !/Hooks need review|Do you trust the contents/.test(frame) &&
          /MCP startup issue|MCP startup incomplete|MCP server is not logged in/.test(frame)
          ? true
          : undefined;
      },
      "cleared native trust gates and startup warning",
      25_000,
    );
    const version = /OpenAI Codex \(v([^)]*)\)/.exec(active.frame())?.[1];
    assert.ok(version, "native welcome identifies the CLI version");
    t.diagnostic(`Native Codex ${version}, 100 × 40 PTY, isolated config, no model turn`);
    // Codex 0.154 collapses diagnostics; Ctrl+T reveals the native transcript overlay.
    if (/MCP startup issue/.test(active.frame())) await active.terminal.sendInput("\u0014");
    const warningFrame = await waitFor(
      () => {
        const frame = active.frame();
        return /The elwood_probe MCP server is not logged in/.test(frame) &&
          /MCP startup incomplete \(failed: elwood_probe\)/.test(frame)
          ? frame
          : undefined;
      },
      "native MCP login and startup diagnostics",
      15_000,
    );
    const warnings = codexWarningsFromText(warningFrame, "native-startup");
    assert.ok(
      warnings.some(
        (warning) =>
          warning.code === "mcp_server_not_logged_in" &&
          warning.mcpServerName === "elwood_probe" &&
          warning.recoveryCommand === "codex mcp login elwood_probe",
      ),
    );
    assert.ok(
      warnings.some(
        (warning) =>
          warning.code === "mcp_startup_incomplete" &&
          warning.failedServers.join(",") === "elwood_probe",
      ),
    );

    async function answer(frame: string, prompt: string, expected: string): Promise<void> {
      const writes: string[] = [];
      const result = responder.handle(
        frame,
        async (input) => {
          writes.push(input);
          await active.terminal.sendInput(input);
        },
        active.frame,
      );
      assert.equal(result?.kind, "attempted", `native ${prompt} must be recognized`);
      if (result?.kind !== "attempted") throw new Error(`Unrecognized ${prompt}:\n${frame}`);
      assert.equal(result.automation.prompt, prompt);
      assert.equal(await result.settled, "answered");
      assert.ok(writes.length > 0, "the native prompt received an affirmative reply");
      assert.ok(
        writes.every((input) => input === expected),
        "every retry uses the native affirmative",
      );
    }
  } finally {
    responder.dispose();
    try {
      await native?.close();
    } finally {
      await mcp.close();
    }
  }
});
