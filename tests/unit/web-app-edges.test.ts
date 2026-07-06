/**
 * Edge coverage for browser dev app debugger events and connection guards.
 * Covers PRD §11 (C-APP-08, C-APP-09).
 */

import type { IncomingMessage } from "node:http";
import { describe, expect, test } from "vitest";
import { activityEvent, terminalExitEvent } from "../../src/app/web-events.ts";
import { isAllowedUpgrade } from "../../src/app/web-security.ts";
import type { ElwoodActivityEvent } from "../../src/index.ts";

describe("browser dev app edge handling", () => {
  test("C-APP-09 clean terminal exits are informational without a signal suffix", () => {
    expect(terminalExitEvent({ elwoodSessionId: "s1", exitCode: 0 })).toMatchObject({
      level: "info",
      summary: "exit 0",
    });
  });

  test("C-APP-09 sparse activity events fall back to their label and payload", () => {
    const event: ElwoodActivityEvent = {
      elwoodSessionId: "s1",
      agent: "codex",
      source: "transcript",
      kind: "reasoning",
      label: "thinking",
    };
    const entry = activityEvent(event);
    expect(entry.summary).toBe("thinking");
    expect(entry.raw).toBe(event);
  });

  test("C-APP-08 upgrades without host or url values are rejected", () => {
    expect(isAllowedUpgrade(request({}), "secret", 4317)).toBe(false);
    expect(isAllowedUpgrade(request({ host: "localhost:4317" }), "secret", 4317)).toBe(false);
  });
});

function request(headers: { readonly host?: string }): IncomingMessage {
  return { headers } as never;
}
