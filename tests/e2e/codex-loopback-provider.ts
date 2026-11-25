/**
 * A loopback model provider for real-Codex e2e tests, so each test chooses every service reply
 * and uses no model quota. Shared by C-SPEED-01 and C-API-65 (PRD §12).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { type CodexSandbox, type E2eProject, makeProject, sandboxedCodexHome } from "./helpers.ts";

export type LoopbackCodexProvider = {
  readonly project: E2eProject;
  readonly sandbox: CodexSandbox;
  /** The `config.toml` the private Codex home was seeded with. */
  readonly config: string;
};

/**
 * Serves `handler` on an ephemeral loopback port until the test ends, and seeds a private Codex
 * home for a new trusted git project whose model provider is that server. The model is the
 * catalog's `gpt-6-astra`, whose service tiers C-SPEED-01 selects. Register this before the
 * session's teardown, so the server closes first.
 */
export async function loopbackCodexProvider(
  t: Pick<TestContext, "after">,
  handler: RequestListener,
): Promise<LoopbackCodexProvider> {
  const server = createServer(handler);
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
  const catalog = new URL("../fixtures/codex-loopback-models.json", import.meta.url);
  writeFileSync(catalogPath, readFileSync(catalog));
  const config = `model_catalog_json = ${JSON.stringify(catalogPath)}
model = "gpt-6-astra"
model_provider = "fixture"
check_for_update_on_startup = false
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
  return { project, sandbox: sandboxedCodexHome(project, config), config };
}
