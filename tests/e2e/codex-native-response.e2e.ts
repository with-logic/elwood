/** Opt-in real cold send and persisted native resume through the CLI collector (C-API-48, C-E2E-14/15). */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalizeRunRequest, resolveRunSettings } from "../../src/cli/request/index.ts";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import { onNativeBoundary } from "../../src/core/simple/native-boundary.ts";
import {
  type CodexHookHandlers,
  CodexSession,
  type CodexSessionApi,
  resumeCodex,
} from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { readSessionRecord } from "../../src/state/store.ts";
import { nativeResponseSandbox, responseBinary, responseModel } from "./codex-response-sandbox.ts";

const available = existsSync(responseBinary) && existsSync(join(homedir(), ".codex/auth.json"));
const coldToken = "ELWOOD_COLD_7F29";
const resumeToken = "ELWOOD_RESUME_4A83";
const promptFor = (token: string) =>
  `Reply with exactly ${token} and nothing else. Do not use tools or inspect files.`;

test("C-API-48 native Codex resume stream excludes the prior cold response", {
  skip:
    process.env["ELWOOD_NATIVE_RESPONSE_PROOF"] === "1"
      ? available
        ? false
        : "requires pinned Codex0.159.2 and auth"
      : "set ELWOOD_NATIVE_RESPONSE_PROOF=1 for two isolated valid-model turns",
  timeout: 150_000,
}, async (t) => {
  assert.equal(process.version, "v24.7.0");
  const env = { ...process.env };
  const sandbox = await nativeResponseSandbox();
  let session: CodexSessionApi | undefined;
  let toolAttempts = 0;
  let acceptanceCount = 0;
  let stopCount = 0;
  let previousId: string | undefined;
  let ownId: string | undefined;
  let expectedPrompt = promptFor(coldToken);
  const off: Array<() => void> = [];
  const hooks: CodexHookHandlers = {
    PreToolUse: () => {
      toolAttempts++;
      void session?.kill();
      return {
        permissionDecision: "deny",
        permissionDecisionReason: "This response fixture permits no tools.",
      };
    },
  };
  const attach = (active: CodexSessionApi) => {
    session = active;
    off.push(
      active.on("hook", (event) => {
        if (event.hook_event_name !== "UserPromptSubmit") return;
        acceptanceCount++;
        assert.equal(event.prompt, expectedPrompt);
        assert.equal(sandbox.writes.enters, 1);
        assert.ok(event.turn_id);
        assert.notEqual(event.turn_id, previousId);
        ownId = event.turn_id;
      }),
      onNativeBoundary(active, (event) => {
        if (event.kind === "stop" && event.turnId === ownId) stopCount++;
      }),
    );
  };
  const assertPhase = () => {
    assert.deepEqual(sandbox.writes, { enters: 1, pastes: 1 });
    assert.equal(acceptanceCount, 1);
    assert.equal(stopCount, 1);
    assert.equal(toolAttempts, 0);
  };
  const options = {
    cwd: sandbox.cwd,
    stateDir: sandbox.stateDir,
    model: responseModel,
    reasoningEffort: "low" as const,
    autotrust: true,
    autoupdate: false,
    sandbox: "read-only" as const,
    approvalPolicy: "never" as const,
    initialSize: { cols: 140, rows: 35 },
    hooks,
  };
  const abort = () => {
    sandbox.end();
    void session?.kill();
  };
  t.signal.addEventListener("abort", abort, { once: true });
  try {
    const cold = new CodexSession(options);
    attach(await cold.start());
    await session!.waitForStatus((status) => status === "ready", 30_000);
    sandbox.begin(expectedPrompt);
    assert.equal((await cold.send(expectedPrompt, { timeoutMs: 45_000 })).trim(), coldToken);
    assertPhase();
    const id = session!.elwoodSessionId;
    previousId = ownId;
    sandbox.end();
    for (const unsubscribe of off.splice(0)) unsubscribe();
    await cold.stop();
    const record = readSessionRecord(sandbox.stateDir, id);
    assert.equal(record.adapter, "codex");
    assert.ok(record.codex?.resumeId);
    // Resume derives its workspace from persisted state; explicit cwd is invalid here.
    const draft = await resolveRunSettings(
      {
        command: "run",
        flags: {
          agent: "codex",
          ignoreDefaults: true,
          stateDir: sandbox.stateDir,
          resume: id,
          images: [],
          codexSandbox: "read-only",
          codexApprovalPolicy: "never",
          reasoningEffort: "low",
          trust: true,
        },
        explicit: new Set(["agent", "resume"]),
        promptWords: [],
      },
      { env: {}, invocationCwd: sandbox.cwd, homeDir: sandbox.home },
    );
    const request = await finalizeRunRequest(draft, { agent: "codex", cwd: record.cwd });
    sandbox.resume();
    ownId = undefined;
    acceptanceCount = 0;
    stopCount = 0;
    expectedPrompt = promptFor(resumeToken);
    const resumed = new HeadlessCliSession(request, id, () =>
      resumeCodex({ ...options, elwoodSessionId: id }),
    );
    attach((await resumed.start()) as CodexSessionApi);
    await session!.waitForStatus((status) => status === "ready", 30_000);
    sandbox.begin(expectedPrompt);
    const text: string[] = [];
    for await (const event of resumed.stream(expectedPrompt, { timeoutMs: 45_000 })) {
      assert.ok(event.type !== "tool_call" && event.type !== "tool_result");
      if (event.type === "text") text.push(event.text);
    }
    const response = text.join("\n\n").trim();
    assert.equal(response, resumeToken);
    assert.ok(!response.includes(coldToken));
    assertPhase();
    t.diagnostic(
      "Pinned Codex0.159.2: cold send + persisted native resume CLI stream; one Enter/UPS/Stop each, no tools.",
    );
  } finally {
    sandbox.end();
    for (const unsubscribe of off) unsubscribe();
    try {
      await session?.kill();
    } finally {
      resetRuntimeSeamsForTests();
      sandbox.dispose();
      t.signal.removeEventListener("abort", abort);
      assert.equal(existsSync(sandbox.root), false);
      assert.deepEqual({ ...process.env }, env);
    }
  }
});
