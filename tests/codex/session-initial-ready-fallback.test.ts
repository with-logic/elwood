/** Ordinary readiness notifications retain throw-after-fan-out fallback (C-API-42). */
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-42 an unscoped throwing ready listener still releases input and warns", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const queued = session.sendMessage("hello");
  const warnings: unknown[] = [];
  session.on("status", (event) => {
    if (event.status === "ready") throw new Error("private listener failure");
  });
  session.on("warning", (event) => warnings.push(event));
  await becomeReady(session.elwoodSessionId, cwd);
  await queued;
  expect(ptys[0]!.writes[0]).toBe("\u001b[200~hello\u001b[201~");
  expect(warnings).toEqual([
    expect.objectContaining({
      agent: "codex",
      code: "initial_ready_fallback",
      raw: "initial_ready_fallback",
    }),
  ]);
  expect(JSON.stringify(warnings)).not.toContain("private listener failure");
});
