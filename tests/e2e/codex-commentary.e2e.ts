/** Real Codex commentary and final text remain distinct (PRD §5.4, C-CODEX-22, C-E2E-17). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexSession, type CodexSessionApi } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { closeNativeResponse, trackResponseKill } from "./codex-response-cleanup.ts";
import {
  nativeResponseSandbox,
  noToolsResponseOptions,
  responseBinary,
} from "./codex-response-sandbox.ts";
import { assertParentEnvironmentUnchanged } from "./parent-environment.ts";

const available = existsSync(responseBinary) && existsSync(join(homedir(), ".codex/auth.json"));
const progress = "ELWOOD_PROGRESS_6F82";
const final = "ELWOOD_FINAL_2D91";
const prompt = `Send a commentary progress update containing exactly ${progress}. Then send a final answer containing exactly ${final}. Do not use tools or inspect files. These must be separate commentary and final messages.`;

function parentConfiguration(): string {
  return ["auth.json", "config.toml", "hooks.json"]
    .map((name) => {
      const path = join(homedir(), ".codex", name);
      return existsSync(path)
        ? createHash("sha256").update(readFileSync(path)).digest("hex")
        : "absent";
    })
    .join(":");
}

test("C-E2E-17 native Codex progress precedes final text without ending the turn", {
  skip:
    process.env["ELWOOD_NATIVE_COMMENTARY_PROOF"] === "1"
      ? available
        ? false
        : "requires pinned Codex 0.159.2 and auth"
      : "set ELWOOD_NATIVE_COMMENTARY_PROOF=1 for one isolated valid-model turn",
  timeout: 180_000,
}, async (t) => {
  const environment = { ...process.env };
  const configuration = parentConfiguration();
  const sandbox = await nativeResponseSandbox();
  let live: CodexSessionApi | undefined;
  let toolAttempts = 0;
  const killAttempts: Promise<void>[] = [];
  const facade = new CodexSession(
    noToolsResponseOptions(sandbox, () => {
      toolAttempts++;
      trackResponseKill(live, killAttempts);
    }),
  );
  const abort = () => {
    sandbox.end();
    trackResponseKill(live, killAttempts);
  };
  t.signal.addEventListener("abort", abort, { once: true });
  try {
    live = await facade.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    const statuses: string[] = [];
    const messages: Array<{ kind: string; text: string; status: string }> = [];
    facade.on("status", (event) => statuses.push(event.status));
    facade.on("activity", (event) => {
      if (event.kind === "assistant_progress" || event.kind === "assistant_message") {
        messages.push({ kind: event.kind, text: event.text?.trim() ?? "", status: live!.status });
      }
    });
    sandbox.begin(prompt);
    assert.equal((await facade.send(prompt, { timeoutMs: 90_000 })).trim(), final);
    assert.deepEqual(
      messages.map(({ kind, text }) => ({ kind, text })),
      [
        { kind: "assistant_progress", text: progress },
        { kind: "assistant_message", text: final },
      ],
    );
    assert.equal(messages[0]!.status, "running");
    assert.ok(statuses.includes("running"));
    assert.equal(live.status, "ready");
    assert.equal(toolAttempts, 0);
    assert.deepEqual(sandbox.writes, { enters: 1, pastes: 1 });
  } finally {
    sandbox.end();
    try {
      await closeNativeResponse(() => facade.close(), live, killAttempts);
    } finally {
      resetRuntimeSeamsForTests();
      t.signal.removeEventListener("abort", abort);
      sandbox.dispose();
      assert.equal(existsSync(sandbox.root), false);
      assertParentEnvironmentUnchanged(environment, process.env);
      assert.equal(
        configuration === parentConfiguration(),
        true,
        "Parent Codex configuration changed",
      );
    }
  }
});
