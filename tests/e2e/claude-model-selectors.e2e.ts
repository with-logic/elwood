/** Discovered Claude model IDs work unchanged at launch and switch (PRD §5.3, C-API-23/24/41). */
import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClaudeSessionApi,
  listClaudeModels,
  startClaude,
  startOrResumeClaude,
} from "../../src/index.ts";
import { rejectCompiledClaudeFallback } from "./claude-compiled-fallback.ts";
import { cleanup, makeProject, skipIf, skipReason } from "./helpers.ts";

test("C-API-23 C-API-24 C-API-41 discovered Claude selectors launch and switch unchanged", {
  skip: skipIf(skipReason("claude")),
  timeout: 150_000,
}, async () => {
  const project = makeProject("claude");
  // The first process in a private config can choose fallback before its catalog initializes.
  await listClaudeModels(project);
  const models = rejectCompiledClaudeFallback(await listClaudeModels(project));
  const versioned = models.filter((model) => /^(?:Opus|Sonnet|Haiku|Fable) \d/.test(model.label));
  const resolvedDefault = models.find((model) => model.isCurrent);
  assert.ok(resolvedDefault?.id, "the initial launch resolves a concrete default");
  const alternatives = versioned.filter((model) => model.id !== resolvedDefault.id);
  const target =
    alternatives.find((model) => model.id?.endsWith("[1m]")) ??
    alternatives.find((model) => model.label.startsWith("Haiku")) ??
    alternatives[0];
  assert.ok(target?.id, "the native picker lists a versioned launch selector");
  assert.match(target.id, /^claude-[a-z0-9-]+(?:\[1m\])?$/);
  const other = versioned.find((model) => model.id !== target.id);
  assert.ok(other?.id, "another versioned selector is available");
  const defaultModel = models.find((model) => model.id === "default");
  assert.ok(defaultModel?.id, "default is a supported native selector");
  let session: ClaudeSessionApi | undefined;
  try {
    const started = await startOrResumeClaude({
      ...project,
      model: target.id,
      autotrust: true,
      highTrust: true,
    });
    assert.equal(started.resumed, false);
    session = started.session;
    await session.waitForStatus((status) => status === "ready", 30_000);
    assert.equal((await session.listModels()).find((model) => model.isCurrent)?.id, target.id);
    await session.setModel(other.id);
    assert.equal((await session.listModels()).find((model) => model.isCurrent)?.id, other.id);
    await session.setModel(target.label.toUpperCase());
    assert.equal((await session.listModels()).find((model) => model.isCurrent)?.id, target.id);
    await cleanup(session);
    session = undefined;
    session = await startClaude({
      ...project,
      model: defaultModel.id,
      autotrust: true,
      highTrust: true,
    });
    await session.waitForStatus((status) => status === "ready", 30_000);
    assert.equal(
      (await session.listModels()).find((model) => model.isCurrent)?.id,
      resolvedDefault.id,
    );
  } finally {
    await cleanup(session);
  }
});
