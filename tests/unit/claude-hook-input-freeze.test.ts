/** Bridge JSON extension fields remain accepted and immutable (C-HOOK-22). */
import { expect, test } from "vitest";
import { freezeHookEvent } from "../../src/core/freeze-hook-event.ts";

test("C-HOOK-22 deep extension data freezes iteratively without response limits", () => {
  const event = { hook_event_name: "Stop" as const, session_id: "s", cwd: "/tmp", extension: {} };
  let child: Record<string, unknown> = event.extension;
  for (let depth = 0; depth < 10_000; depth += 1) {
    const next = { values: [null, true, 42, "text"] };
    child["next"] = next;
    child = next;
  }
  expect(freezeHookEvent(event)).toBe(event);
  expect(Object.isFrozen(event)).toBe(true);
  expect(Object.isFrozen(child)).toBe(true);
  expect(Object.isFrozen(child["values"])).toBe(true);
  expect(Reflect.set(child, "next", {})).toBe(false);
});
