/**
 * Finding A: the native PTY-exit callback contains flush + emission failures and
 * still reaches a terminal status AND reaps the descendant tree. Covers PRD
 * §5.3/§9.4 (C-LIFE-10): transcript drain, terminal:exit/activity emission, and
 * status submission all run BEFORE the reap, so a throw in any of them must not
 * abort the unconditional reap or leak the session non-terminal.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("C-LIFE-10 exit-callback error boundary", () => {
  for (const event of ["terminal:exit", "activity", "status"] as const) {
    test(`a throwing '${event}' listener still reaches 'exited' and reaps`, () => {
      // A caller listener that throws during the exit callback must not abort it:
      // the session reaches terminal AND the group is reaped (in submitExit's
      // `finally`), and the throw never escapes the native exit callback.
      const cwd = tempDir();
      installFakes();
      return startClaude({ cwd }).then((session) => {
        const pty = ptys.at(-1)!;
        session.on(event, () => {
          throw new Error(`boom from ${event} listener`);
        });
        reapedGroups.length = 0;
        // The native exit callback must not throw out even though a listener does.
        expect(() => pty.emitExit({ exitCode: 0 })).not.toThrow();
        expect(session.status).toBe("exited"); // terminal despite the listener throw
        expect(reapedGroups).toEqual([pty.pid]); // the unconditional reap still ran
      });
    });
  }
});
