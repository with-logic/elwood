/** Real Codex service tiers at the HTTP boundary, without model quota. C-SPEED-01. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { isRecord } from "../../src/core/predicates.ts";
import {
  type CodexSessionApi,
  type CodexTokenUsage,
  resumeCodex,
  startCodex,
} from "../../src/index.ts";
import { codexLaunches, endCodexTestAfter } from "./codex-test-end.ts";
import { makeProject, sandboxedCodexHome, skipIf, skipReason, waitFor } from "./helpers.ts";

test("C-SPEED-01 C-STATS-01 Codex selects tiers and reports native usage across resumes", {
  skip: skipIf(skipReason("codex")),
  timeout: 120_000,
}, async (t) => {
  const requests: string[] = [];
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void respond(request, response).catch((error: unknown) => {
      failures.push(error);
      response.destroy();
    });
  });
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    assert(isRecord(body), "Expected a Responses request object");
    const tier = body["service_tier"];
    assert(
      tier === undefined || tier === "default" || tier === "priority" || tier === "ultrafast",
      `Unexpected service_tier: ${JSON.stringify(tier)}`,
    );
    requests.push(tier === undefined ? "default" : tier);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const id = `fixture_${requests.length}`;
    const item = {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      phase: "final_answer",
      status: "completed",
      content: [{ type: "output_text", text: "SPEED VERIFIED", annotations: [] }],
    };
    const send = (type: string, data: Record<string, unknown>) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("response.created", {
      response: { id, object: "response", status: "in_progress", output: [] },
    });
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", {
      response: {
        id,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
      },
    });
    response.end();
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const project = makeProject("codex");
  execFileSync("git", ["init", "-q", project.cwd]);
  const catalogPath = join(project.cwd, "models.json");
  writeFileSync(
    catalogPath,
    readFileSync(new URL("../fixtures/speed-models.json", import.meta.url)),
  );
  const config = `model_catalog_json = ${JSON.stringify(catalogPath)}
model = "gpt-6-astra"
model_provider = "fixture"
[model_providers.fixture]
name = "Loopback fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.${JSON.stringify(project.cwd)}]
trust_level = "trusted"
[tui]
screen_reader_detection_done = true
`;
  const sandbox = sandboxedCodexHome(project, config);
  const launches = codexLaunches();
  let session: CodexSessionApi | undefined;
  t.after(() => endCodexTestAfter(t, { sessions: [session], sandbox, launches }));
  let id: string | undefined;
  for (const serviceTier of ["fast", "ultrafast", "default"] as const) {
    const options = {
      cwd: project.cwd,
      stateDir: project.stateDir,
      serviceTier,
      sandbox: "read-only" as const,
      approvalPolicy: "never" as const,
      autotrust: true,
    };
    session = await launches.track(
      id === undefined ? startCodex(options) : resumeCodex({ ...options, elwoodSessionId: id }),
    );
    id ??= session.elwoodSessionId;
    assert.equal(session.elwoodSessionId, id);
    const current = session;
    await waitFor(() => (current.status === "ready" ? true : undefined), "speed ready", 30_000);
    const before = requests.length;
    let completed = false;
    let usage: CodexTokenUsage | undefined;
    current.on("activity", (event) => {
      if (event.kind === "assistant_message" && event.text?.includes("SPEED VERIFIED"))
        completed = true;
      if (event.tokenUsage?.scope === "thread") usage = event.tokenUsage;
    });
    await current.sendMessage("Reply SPEED VERIFIED. Do not use tools.");
    const observed = await waitFor(
      () => {
        assert.deepEqual(failures, [], "Loopback provider rejected a native request");
        return completed && current.status === "ready" ? usage : undefined;
      },
      "speed turn complete",
      30_000,
    );
    assert.equal(observed.last?.totalTokens, 23);
    assert(observed.total.totalTokens >= 23);
    assert(requests.length > before);
    assert(
      requests
        .slice(before)
        .every((value) => value === (serviceTier === "fast" ? "priority" : serviceTier)),
    );
    await current.stop();
  }
  assert.equal(readFileSync(sandbox.configPath, "utf8"), config);
});
