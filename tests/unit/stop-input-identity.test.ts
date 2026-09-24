/** Expired Stop authority follows one runtime instance, not an ID shared elsewhere (C-HOOK-04). */
import { expect, test } from "vitest";
import { admitHookInput, withStopInput } from "../../src/core/stop-input.ts";

test("C-HOOK-04 same-ID sessions retain separate Stop input authority", async () => {
  const first = { elwoodSessionId: "reused" };
  const second = { elwoodSessionId: "reused" };
  const release = Promise.withResolvers<void>();
  let late: Promise<readonly [unknown, string]> | undefined;
  await withStopInput({ hookName: "Stop", session: first }, () => {
    late = (async () => {
      await release.promise;
      let expired: unknown;
      try {
        admitHookInput(first, () => "wrong");
      } catch (error) {
        expired = error;
      }
      return [expired, admitHookInput(second, () => "allowed")] as const;
    })();
    return Promise.resolve();
  });
  release.resolve();
  const [expired, allowed] = await late!;
  expect(expired).toMatchObject({ code: "wait_timeout" });
  expect(allowed).toBe("allowed");
});
