/**
 * Billing, usage-limit, rate-limit and server failures from the real Codex CLI reach a raw
 * `activity` listener as `turn_failure` with the category PRD §5.4 assigns (C-API-65). A loopback
 * model provider answers each turn with the service error its prompt names, so no model quota is
 * used.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CodexSessionApi, ElwoodTurnFailureCategory } from "../../src/index.ts";
import { loopbackCodexProvider } from "./codex-loopback-provider.ts";
import { startReadyCodex } from "./codex-ready.ts";
import { codexLaunches, endCodexTestAfter } from "./codex-test-end.ts";
import { observeSession, skipIf, skipReason } from "./helpers.ts";
import { isTurnFailure, waitWithEvidence } from "./turn-failure.ts";

type Shape = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly error: Readonly<Record<string, unknown>>;
  readonly category: ElwoodTurnFailureCategory;
};

const usageLimit = { type: "usage_limit_reached", message: "The usage limit has been reached" };

/** Service replies, keyed by the marker each turn's prompt carries. */
const shapes: Readonly<Record<string, Shape>> = {
  "workspace-owner-credits": {
    status: 429,
    headers: { "x-codex-rate-limit-reached-type": "workspace_owner_credits_depleted" },
    error: { ...usageLimit, plan_type: "business" },
    category: "quota_or_credit",
  },
  "insufficient-quota": {
    status: 429,
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: "You exceeded your current quota, please check your plan and billing details.",
    },
    category: "quota_or_credit",
  },
  "usage-limit": {
    status: 429,
    error: { ...usageLimit, plan_type: "team" },
    category: "usage_limit",
  },
  // Codex retries these before failing the turn: about 6.5 s, 7 s and 25 s.
  "rate-limit": {
    status: 429,
    headers: { "retry-after": "1" },
    error: { type: "requests", code: "rate_limit_exceeded", message: "Rate limit reached" },
    category: "rate_limited",
  },
  "payment-required": {
    status: 402,
    error: { type: "billing_error", code: "payment_required", message: "Payment required." },
    category: "quota_or_credit",
  },
  "server-error": {
    status: 500,
    error: { type: "server_error", message: "The server had an error." },
    category: "network_or_api",
  },
};

/** The shape whose marker comes last in the request: the newest prompt in its history. */
function requestedShape(body: string): Shape | undefined {
  let found: { readonly at: number; readonly shape: Shape } | undefined;
  for (const [name, shape] of Object.entries(shapes)) {
    const at = body.lastIndexOf(`shape:${name}`);
    if (at >= 0 && (found === undefined || at > found.at)) found = { at, shape };
  }
  return found?.shape;
}

test("C-API-65 real Codex billing, usage-limit, rate-limit and server failures carry their category", {
  skip: skipIf(skipReason("codex")),
  timeout: 240_000,
}, async (t) => {
  const unmatched: string[] = [];
  const { project, sandbox } = await loopbackCodexProvider(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const shape = requestedShape(Buffer.concat(chunks).toString());
      if (shape === undefined) unmatched.push(`${request.method} ${request.url}`);
      response.writeHead(shape?.status ?? 400, {
        "content-type": "application/json",
        ...shape?.headers,
      });
      response.end(JSON.stringify({ error: shape?.error ?? { message: "unexpected request" } }));
    });
  });
  const launches = codexLaunches();
  let session: CodexSessionApi | undefined;
  t.after(() => endCodexTestAfter(t, { sessions: [session], sandbox, launches }));
  const live = await startReadyCodex(project, {
    launches,
    onStarted: (started) => {
      session = started;
    },
  });
  const observed = observeSession(live);
  const { activities } = observed;
  const turnIds: string[] = [];
  const categories: Record<string, ElwoodTurnFailureCategory> = {};
  for (const name of Object.keys(shapes)) {
    const turnStartIndex = activities.length;
    await live.sendMessage(`Reply OK. shape:${name}`);
    const turn = () => activities.slice(turnStartIndex);
    const failure = await waitWithEvidence(
      () => turn().find(isTurnFailure),
      `${name} turn_failure`,
      60_000,
      live,
      observed,
    );
    await live.waitForStatus((status) => status === "ready", 60_000);
    const submit = turn().find((event) => event.hookEventName === "UserPromptSubmit");
    assert.ok(submit?.turnId, `${name}: the submit hook names the turn`);
    assert.equal(failure.turnId, submit.turnId, name);
    assert.equal(failure.label, failure.turnFailure.category, name);
    assert.equal(failure.turnFailure.disposition, "final", name);
    assert.notEqual(failure.turnFailure.message.trim(), "", name);
    turnIds.push(submit.turnId);
    categories[name] = failure.turnFailure.category;
  }
  // Compared together, so a failing run names every shape Elwood misclassified.
  const expected = Object.fromEntries(
    Object.entries(shapes).map(([name, shape]) => [name, shape.category]),
  );
  assert.deepEqual(
    categories,
    expected,
    `requests without a shape: ${unmatched.join(", ") || "none"}`,
  );
  // Counted after teardown's final transcript flush, so a late duplicate would be seen.
  await live.teardown();
  assert.deepEqual(
    activities.filter(isTurnFailure).map((event) => event.turnId),
    turnIds,
  );
  assert.deepEqual(unmatched, []);
  observed.dispose();
});
