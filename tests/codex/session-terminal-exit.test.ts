/** Final PTY output survives immediate session exit (PRD §9.4, C-LIFE-12). */

import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  false,
  true,
])("C-LIFE-12 exit drains final output (throwing observer: %s)", async (throws) => {
  installFakes();
  const session = await startCodex({ cwd: tempDir() });
  const seen: string[] = [];
  session.on("terminal:data", ({ data }) => {
    seen.push(data);
    if (throws) throw new Error("observer failed");
  });
  session.on("terminal:exit", () => seen.push("exit"));
  const pty = ptys[0]!;
  pty.emitData("FINAL_OUTPUT");
  pty.emitExit({ exitCode: 0 });
  expect(session.status).toBe("exited");
  expect(reapedGroups).toContain(pty.pid);
  expect(seen).toEqual(["exit"]);
  await session.stop(); // Joins the automatic cleanup started by terminal status.
  expect(seen).toEqual(["exit", "FINAL_OUTPUT"]);
});
