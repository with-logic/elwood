/**
 * A deciding `model_reasoning_effort` entry in `configOverrides` whose effort Elwood does not
 * recognize holds no readiness wait, on start and on resume, and the session emits one
 * content-free `codex_effort_unrecognized` warning (PRD §5.3, §5.7, C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  deadlineOnDefaultFooter,
  effortDefault,
  paste,
  resumeWithQueuedMessage,
} from "./effort-footer.ts";
import { resetFakes } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

const unrecognized = [
  // Codex 0.172 decodes this basic string's escape as `low`; Elwood does not read escapes.
  'model_reasoning_effort="lo\\u0077"',
  // Codex 0.172 launches with an effort it does not know (docs/cli-behavior.md).
  'model_reasoning_effort="extreme"',
];

const warning = (elwoodSessionId: string) => ({
  elwoodSessionId,
  agent: "codex",
  source: "lifecycle",
  code: "codex_effort_unrecognized",
  severity: "warning",
  message:
    "Elwood did not recognize the reasoning effort that the last model_reasoning_effort entry in configOverrides sets. Codex receives it unchanged, but readiness does not wait for Codex to apply it, so a mode or model picked before then can be discarded.",
  raw: "codex_effort_unrecognized",
});

test.each(
  unrecognized,
)("C-API-28 a start whose deciding entry is %s holds no wait and warns once", async (override) => {
  const { session, warnings, queued, waited, pty } = await deadlineOnDefaultFooter({
    configOverrides: ['model_reasoning_effort="high"', override],
  });
  try {
    expect(await waited).toBe("ready");
    await queued;
    expect(pty.writes).toContain(paste);
    expect(warnings).toEqual([warning(session.elwoodSessionId)]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test.each(
  unrecognized,
)("C-API-28 a resume whose deciding entry is %s holds no wait and warns once", async (override) => {
  const { resumed, warnings, queued, ready, render, pty } = await resumeWithQueuedMessage({
    configOverrides: ['model_reasoning_effort="high"', override],
  });
  try {
    await render(effortDefault);
    expect(await ready).toBe("ready");
    await queued;
    expect(pty.writes).toContain(paste);
    expect(warnings).toEqual([warning(resumed.elwoodSessionId)]);
  } finally {
    await resumed.teardown();
  }
});
