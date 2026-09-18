/**
 * The Codex config transaction's two termination properties: a switch still WAITING for
 * the process-wide lock rejects as soon as its session closes, and the CLI-exit barrier
 * applies on the success path too (PRD §5.3, C-CODEX-14).
 */

import { expect, test } from "vitest";
import { runCodexModelSwitch } from "../../src/codex/config/transaction.ts";

/** A holder that occupies the process-wide lock until the returned release is called. */
function holdTheLock(): { readonly release: () => void; readonly held: Promise<void> } {
  let release: () => void = () => undefined;
  const applied = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = runCodexModelSwitch({
    snapshot: () => "snap",
    apply: () => applied,
    restore: () => undefined,
  });
  return { release, held };
}

test("C-CODEX-14 a switch queued behind the config lock rejects when its session closes", async () => {
  const { release, held } = holdTheLock();
  const closing = new AbortController();
  let waiterApplied = false;
  const queued = runCodexModelSwitch({
    snapshot: () => "snap",
    apply: () => {
      waiterApplied = true;
      return Promise.resolve();
    },
    restore: () => undefined,
    cancel: { signal: closing.signal, error: () => new Error("session_not_running") },
  }).catch((error: Error) => error.message);
  // The session closes while the FIRST transaction still holds the lock.
  closing.abort();
  // The caller learns at once, without waiting for the holder to finish.
  expect(await queued).toBe("session_not_running");
  expect(waiterApplied, "a cancelled waiter must never take the critical section").toBe(false);
  release();
  await held;
});

test("C-CODEX-14 a cancelled waiter does not run its task once the lock frees", async () => {
  const { release, held } = holdTheLock();
  const closing = new AbortController();
  let waiterApplied = false;
  const queued = runCodexModelSwitch({
    snapshot: () => "snap",
    apply: () => {
      waiterApplied = true;
      return Promise.resolve();
    },
    restore: () => undefined,
    cancel: { signal: closing.signal, error: () => new Error("session_not_running") },
  }).catch((error: Error) => error.message);
  closing.abort();
  await queued;
  release();
  await held;
  // Releasing the lock must not belatedly run the cancelled switch against config.toml.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(waiterApplied).toBe(false);
});

test("C-CODEX-14 a switch interrupted by close waits for the CLI exit before restoring", async () => {
  const order: string[] = [];
  let releaseExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    releaseExit = () => {
      order.push("exit");
      resolve();
    };
  });
  const switching = runCodexModelSwitch({
    snapshot: () => "snap",
    // Closing aborts the picker's reads and writes, so the switch rejects; the dying CLI
    // can still write config.toml, which is what the exit barrier is for.
    apply: () => {
      order.push("applied");
      return Promise.reject(new Error("session_not_running"));
    },
    waitForCliExit: () => exited,
    restore: () => order.push("restored"),
  }).catch((error: Error) => error.message);
  // The caller is told AT ONCE rather than held for the five-second exit bound.
  expect(await switching).toBe("session_not_running");
  expect(order, "the restore must not precede the observed exit").toEqual(["applied"]);
  releaseExit();
  await exited;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(order).toEqual(["applied", "exit", "restored"]);
});

/**
 * Once termination has already rejected the call, a restore failure can no longer reach the
 * caller through the returned promise. It must be REPORTED rather than swallowed, or
 * `config.toml` silently keeps the temporary model as the user's default (C-CODEX-14).
 */
test("C-CODEX-14 a restore that fails after a termination rejection is still reported", async () => {
  const reported: string[] = [];
  const failure = await runCodexModelSwitch({
    snapshot: () => "snap",
    apply: () => Promise.reject(new Error("session_not_running")),
    waitForCliExit: () => Promise.resolve(),
    restore: () => {
      throw new Error("compare-and-swap refused");
    },
    onRestoreError: (error) => reported.push((error as Error).message),
  }).catch((error: Error) => error.message);
  expect(failure).toBe("session_not_running");
  expect(reported).toEqual(["compare-and-swap refused"]);
});

/**
 * An `AbortSignal` does not replay a past abort to a newly added listener, so the
 * already-aborted case needs its own check. Without it a `setModel` called on a session
 * that had ALREADY closed waits out the current holder and its five-second exit barrier.
 */
test("C-CODEX-14 a switch started on an already-closed session rejects at once", async () => {
  const { release, held } = holdTheLock();
  const closed = new AbortController();
  closed.abort();
  const queued = runCodexModelSwitch({
    snapshot: () => "snap",
    apply: () => Promise.resolve(),
    restore: () => undefined,
    cancel: { signal: closed.signal, error: () => new Error("session_not_running") },
  }).catch((error: Error) => error.message);
  const outcome = await Promise.race([
    queued,
    new Promise((resolve) => setTimeout(() => resolve("STILL_PENDING"), 300)),
  ]);
  expect(outcome).toBe("session_not_running");
  release();
  await held;
});
