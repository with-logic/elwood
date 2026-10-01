/** Pending Stop continuations retain an opaque identity, not the session graph (C-HOOK-04). */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { withStopInput } from "../../src/core/stop-input.ts";

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

async function pendingContinuation() {
  const session = { elwoodSessionId: "collectable", graph: new Uint8Array(1024) };
  const weak = new WeakRef(session);
  const release = Promise.withResolvers<void>();
  let late: Promise<void> | undefined;
  await withStopInput({ hookName: "Stop", session }, () => {
    late = release.promise.then(() => undefined);
    return Promise.resolve();
  });
  return { weak, release, late };
}

test("C-HOOK-04 a hung continuation does not retain its finalized session", async () => {
  const pending = await pendingContinuation();
  try {
    await expect
      .poll(() => {
        collectGarbage();
        return pending.weak.deref() === undefined;
      })
      .toBe(true);
  } finally {
    pending.release.resolve();
    await pending.late;
  }
});
