/** Runnable example diagnostics omit raw startup screen text (C-ATTN-06). */
import { expect, test } from "vitest";
import { activityLogLine } from "../../examples/support.ts";
import { unrecognizedStartupActivity } from "../../src/core/activity/startup.ts";
import { activity } from "../helpers/activity.ts";

test("C-ATTN-06 the example logs startup diagnostics without screen text", () => {
  const event = unrecognizedStartupActivity("codex", "session", "private screen sentinel");
  expect(activityLogLine(event)).toBe(
    "[activity] codex:unrecognized_startup:initial_ready_backstop\n",
  );
  expect(activityLogLine(activity({ text: "assistant response" }))).toContain("assistant response");
});
