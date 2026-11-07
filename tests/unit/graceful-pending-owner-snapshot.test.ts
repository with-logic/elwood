/** Late positive snapshots cannot restore authority lost at native exit (C-LIFE-10). */
import { expect, test } from "vitest";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { gracefulTermination } from "../helpers/graceful-termination.ts";
import {
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
test("C-LIFE-10 a late positive first snapshot cannot signal the vetoed original group", async () => {
  const first = Promise.withResolvers<readonly ProcessEntry[]>();
  const originalHelper = hook(5001, { pgid: LEADER });
  const independent = hook(5002);
  const fake = scripted([]);
  let reads = 0;
  const fixture = gracefulTermination({
    ...fake.ops,
    listProcesses: () =>
      ++reads === 1
        ? first.promise
        : Promise.resolve(
            fake.asRead([
              { ...originalHelper, ppid: 1 },
              { ...independent, ppid: 1 },
            ]),
          ),
  });
  const vetoes: unknown[] = [];
  fixture.pty.onExit(() => {
    try {
      fixture.reaper.reap();
    } catch (error) {
      vetoes.push(error);
    }
  });
  const result = terminatePty(fixture.pty, "SIGTERM", fixture.reaper, {
    gracefulMs: 0,
    forceMs: 0,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  fixture.exit();
  expect(vetoes).toMatchObject([
    { message: "The leader exited before signal ownership was verified." },
  ]);
  first.resolve([leaderRow, originalHelper, independent]);
  expect(await result).toMatchObject({
    code: "termination_failed",
    details: { reapError: "The leader exited before signal ownership was verified." },
  });
  expect(fixture.ptySignals).toEqual([]);
  expect(fake.calls).toContain("kill 5002");
  expect(fake.calls).not.toContain(`stop ${LEADER}`);
  expect(fake.calls).not.toContain(`kill ${LEADER}`);
});
