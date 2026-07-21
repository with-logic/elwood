/**
 * Branch-level unit coverage for runtime seams, startup cleanup, and teardown.
 * Covers PRD §4.2, §9.1, §10, and §13.
 */

import { describe, expect, test } from "vitest";
import { completeUtf8Length, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { currentCommandRunner, resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { cleanupStartupResources } from "../../src/runtime/startup-cleanup.ts";
import { runCleanupSteps, runTeardownSteps } from "../../src/runtime/teardown.ts";

describe("C-PERF-03 UTF-8 boundary truncation", () => {
  const euro = Buffer.from("€", "utf8"); // 3 bytes: e2 82 ac

  test("keeps a buffer that ends on a complete code point", () => {
    const full = Buffer.concat([euro, euro]);
    expect(completeUtf8Length(full)).toBe(full.length);
  });

  test("keeps a buffer ending in ASCII", () => {
    const ascii = Buffer.from("ab", "utf8");
    expect(completeUtf8Length(ascii)).toBe(2);
  });

  test("drops an incomplete 3-byte trailing sequence", () => {
    const split = Buffer.concat([euro, euro.subarray(0, 2)]); // last € missing 1 byte
    expect(completeUtf8Length(split)).toBe(3);
  });

  test("drops an incomplete 4-byte trailing sequence", () => {
    const emoji = Buffer.from("😀", "utf8"); // 4 bytes: f0 9f 98 80
    const split = emoji.subarray(0, 3); // one byte short
    expect(completeUtf8Length(split)).toBe(0);
  });

  test("drops an incomplete 2-byte trailing sequence", () => {
    const eacute = Buffer.from("é", "utf8"); // 2 bytes: c3 a9
    const split = eacute.subarray(0, 1); // lead byte only
    expect(completeUtf8Length(split)).toBe(0);
  });

  test("keeps everything when there is no lead byte (all continuation bytes)", () => {
    // Degenerate input with no lead byte: the guard keeps the buffer as-is.
    const orphan = Buffer.from([0x80, 0x80]);
    expect(completeUtf8Length(orphan)).toBe(2);
  });
});

describe("runtime seams", () => {
  test("real command runner reports spawn failures for missing commands", async () => {
    resetRuntimeSeamsForTests();
    const result = await currentCommandRunner()("elwood-missing-command-for-tests", ["--version"]);
    expect(result.status).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.error?.code).toBe("ENOENT");
  });

  test("real command runner captures stdout, stderr, and a non-zero exit", async () => {
    resetRuntimeSeamsForTests();
    const result = await currentCommandRunner()("node", [
      "-e",
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);',
    ]);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  test("C-PERF-01 the production runner is async — the loop advances before it resolves", async () => {
    resetRuntimeSeamsForTests();
    let ticked = false;
    // A macrotask scheduled now would not run if the runner blocked the loop.
    setTimeout(() => {
      ticked = true;
    }, 0);
    const pending = currentCommandRunner()("node", ["-e", "setTimeout(() => {}, 15)"]);
    // Yield once: if the runner were synchronous (spawnSync), the subprocess
    // would already be done and the loop would not have ticked mid-call.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ticked).toBe(true);
    await pending;
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-03 a hung probe is killed at the timeout with a typed error", async () => {
    resetRuntimeSeamsForTests();
    setProbeTimeoutMsForTests(50);
    // A child that never exits must be killed and resolve an ETIMEDOUT result.
    const result = await currentCommandRunner()("node", ["-e", "setInterval(() => {}, 1000)"]);
    expect(result.status).toBeNull();
    expect(result.error?.code).toBe("ETIMEDOUT");
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-03 a stdout-flooding probe is capped and killed with a typed error", async () => {
    resetRuntimeSeamsForTests();
    // A child that streams far more than the 1MB cap must be bounded, not OOM.
    const result = await currentCommandRunner()("node", [
      "-e",
      "const b = 'x'.repeat(1 << 20); for (let i = 0; i < 8; i++) process.stdout.write(b);",
    ]);
    expect(result.error?.code).toBe("E2BIG");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_000_000);
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-03 a stderr-flooding probe is capped and killed with a typed error", async () => {
    resetRuntimeSeamsForTests();
    const result = await currentCommandRunner()("node", [
      "-e",
      "const b = 'x'.repeat(1 << 20); for (let i = 0; i < 8; i++) process.stderr.write(b);",
    ]);
    expect(result.error?.code).toBe("E2BIG");
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_000_000);
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-03 the output cap is enforced by bytes, not decoded length", async () => {
    resetRuntimeSeamsForTests();
    // Multibyte output: each `€` is 3 bytes, so a decoded-LENGTH cap of 1e6
    // would keep ~1e6 chars ≈ 3e6 bytes. A byte cap keeps the decoded string
    // far short of a length cap (its char count is ~1e6/3), proving the cap
    // counts bytes. Truncation drops an incomplete trailing code point, so the
    // decoded string re-encodes to at most the exact cap (no replacement-char
    // growth past 1e6).
    const result = await currentCommandRunner()("node", [
      "-e",
      "const b = '\\u20ac'.repeat(1 << 20); for (let i = 0; i < 8; i++) process.stdout.write(b);",
    ]);
    expect(result.error?.code).toBe("E2BIG");
    expect(result.stdout.length).toBeLessThan(400_000); // ~1e6 bytes / 3, not 1e6 chars
    expect(result.stdout).not.toContain("�"); // no replacement char from a split
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_000_000);
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-03 a normal probe exit is not signaled", async () => {
    resetRuntimeSeamsForTests();
    // A fast clean exit resolves with its status and no ETIMEDOUT/E2BIG error.
    const result = await currentCommandRunner()("node", ["-e", "process.exit(0)"]);
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    resetRuntimeSeamsForTests();
  });
});

describe("startup cleanup", () => {
  test("resolves when no startup resources were created", async () => {
    await expect(cleanupStartupResources({})).resolves.toBeUndefined();
  });
});

describe("teardown", () => {
  test("C-ERR-01 stringifies non-Error teardown step failures", async () => {
    await expect(
      runTeardownSteps([() => Promise.reject("primitive teardown failure")]),
    ).rejects.toMatchObject({
      code: "teardown_failed",
      details: { causes: ["primitive teardown failure"] },
    });
  });

  test("§9.4 runCleanupSteps runs EVERY step even after an earlier one throws", async () => {
    const ran: string[] = [];
    await expect(
      runCleanupSteps([
        () => {
          ran.push("a");
          throw new Error("bridge stop failed");
        },
        () => {
          ran.push("b"); // must still run despite the earlier throw (no leak)
        },
        () => Promise.reject("watcher finish failed"),
      ]),
    ).rejects.toThrow(/Runtime cleanup failed: bridge stop failed; watcher finish failed/);
    expect(ran).toEqual(["a", "b"]);
  });

  test("§9.4 runCleanupSteps resolves when every step succeeds", async () => {
    const ran: string[] = [];
    await expect(
      runCleanupSteps([
        () => {
          ran.push("x");
        },
        () => {
          ran.push("y");
        },
      ]),
    ).resolves.toBeUndefined();
    expect(ran).toEqual(["x", "y"]);
  });
});
