/**
 * Coverage for bounded child-process lookup during dev web app teardown.
 * Covers PRD §11 (C-APP-08): only "no matches" (status 1) means "no children";
 * every other unsuccessful pgrep outcome is an OPERATIONAL failure that is surfaced
 * through a bounded, content-free diagnostic rather than silently skipping cleanup.
 */

import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  type ChildLookupDiagnostic,
  childPids,
  classifyChildLookup,
  setChildLookupReporter,
} from "../../src/app/child-lookup.ts";

type PgrepResult = Pick<SpawnSyncReturns<string>, "error" | "signal" | "status">;
// `error` is omitted (not set to undefined) to satisfy exactOptionalPropertyTypes.
const result = (overrides: Partial<PgrepResult>): PgrepResult => ({
  signal: null,
  status: null,
  ...overrides,
});

describe("C-APP-08 child-process lookup classification", () => {
  test("status 0 (matches) and status 1 (no matches) are NOT failures", () => {
    // The two normal outcomes must never be surfaced as operational failures:
    // status 0 = children found, status 1 = none found. Both return undefined.
    expect(classifyChildLookup(result({ status: 0 }))).toBeUndefined();
    expect(classifyChildLookup(result({ status: 1 }))).toBeUndefined();
  });

  test("a spawn error, a timeout, a signal, and an unexpected status each classify distinctly", () => {
    // A wedged/absent/killed pgrep or an unexpected exit status must NOT masquerade
    // as "no children"; each is a bounded, content-free operational diagnostic.
    const spawnErr = result({ error: Object.assign(new Error("x"), { code: "ENOENT" }) });
    expect(classifyChildLookup(spawnErr)).toEqual({ reason: "spawn_error", detail: "ENOENT" });
    const timeout = result({ error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) });
    expect(classifyChildLookup(timeout)).toEqual({ reason: "timeout", detail: "ETIMEDOUT" });
    const killed = result({ signal: "SIGKILL" });
    expect(classifyChildLookup(killed)).toEqual({ reason: "signal", detail: "SIGKILL" });
    const badStatus = result({ status: 2 });
    expect(classifyChildLookup(badStatus)).toEqual({ reason: "status", detail: "2" });
  });

  test("a spawn error with no errno code falls back to a bounded token", () => {
    const codeless = result({ error: new Error("no code") });
    expect(classifyChildLookup(codeless)).toEqual({ reason: "spawn_error", detail: "ERR" });
  });

  test("childPids returns [] and surfaces NO diagnostic for the normal no-matches case", () => {
    // A real spawnSync against a bogus pid exits with status 1 (no matches) — the
    // common leaf case. childPids must return [] and NOT invoke the reporter, so only
    // true operational failures reach the debugger.
    const seen: ChildLookupDiagnostic[] = [];
    const previous = setChildLookupReporter((d) => seen.push(d));
    try {
      expect(childPids(999_999_999)).toEqual([]);
      expect(seen).toEqual([]); // status 1 is normal: no diagnostic surfaced
    } finally {
      setChildLookupReporter(previous);
    }
  });

  test("childPids surfaces an OPERATIONAL failure through the reporter, then returns []", () => {
    // When pgrep fails operationally (here a timeout via the injected runner), the
    // descendant cleanup is skipped — but NOT silently: the reporter fires with the
    // bounded diagnostic (pid + reason + detail) so the gap is visible (C-APP-08).
    const seen: ChildLookupDiagnostic[] = [];
    const previous = setChildLookupReporter((d) => seen.push(d));
    try {
      const timedOut = childPids(7, () => ({
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
        signal: null,
        status: null,
        stdout: "",
      }));
      expect(timedOut).toEqual([]); // no children could be determined
      expect(seen).toEqual([{ pid: 7, reason: "timeout", detail: "ETIMEDOUT" }]);
    } finally {
      setChildLookupReporter(previous);
    }
  });

  test("childPids parses matched pids on the success path (status 0)", () => {
    // status 0 with stdout carries real child pids; whitespace-split, filtered to
    // positive integers — no diagnostic (a clean success).
    const seen: ChildLookupDiagnostic[] = [];
    const previous = setChildLookupReporter((d) => seen.push(d));
    try {
      const pids = childPids(1, () => ({
        signal: null,
        status: 0,
        stdout: "10\n20\n-3\nx\n",
      }));
      expect(pids).toEqual([10, 20]); // negatives and non-numerics dropped
      expect(seen).toEqual([]);
    } finally {
      setChildLookupReporter(previous);
    }
  });

  test("setChildLookupReporter returns the prior reporter so it can be restored", () => {
    const first = () => undefined;
    const previous = setChildLookupReporter(first);
    const restored = setChildLookupReporter(previous);
    // Installing `first` then restoring returns `first` — proving the swap round-trips.
    expect(restored).toBe(first);
    setChildLookupReporter(previous);
  });

  test("the DEFAULT reporter writes one bounded, content-free structured line to stderr", () => {
    // The out-of-the-box reporter (before the web app installs its own) must still
    // make a failure visible: a single structured stderr line carrying only bounded
    // tokens (pid, reason, detail) — never any raw system message or content.
    // Capture the default by swapping to a no-op and reading back the previous one.
    const original = setChildLookupReporter(() => undefined);
    setChildLookupReporter(original); // restore immediately; `original` IS the default
    const writes: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      original({ pid: 42, reason: "timeout", detail: "ETIMEDOUT" });
    } finally {
      process.stderr.write = realWrite;
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("pid=42");
    expect(writes[0]).toContain("reason=timeout");
    expect(writes[0]).toContain("detail=ETIMEDOUT");
  });
});
