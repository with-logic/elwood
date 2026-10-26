/**
 * Test-only PTY seam for real-CLI timing tests. The CLI runs normally while its output can
 * be held from Elwood for a fixed time, so Elwood's view trails the CLI on demand, and raw
 * output is matched chunk by chunk. Used by the Codex e2e tests for C-API-28 and C-TRUST-01.
 */

import { createCliSanitizer } from "../../src/cli/output/sanitize.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";

/** Raw output kept across chunks: ample for one phrase's cursor moves and colors. */
const carryLength = 4_096;

export type HeldOutput = {
  /** Holds later CLI output from Elwood for `ms`, then delivers it in order. */
  hold(ms: number, onRelease?: () => void): void;
  /** Whether CLI output, including the chunk being observed, is held from Elwood. */
  readonly holding: boolean;
};

export type OutputHoldHooks = {
  /** Sees each raw CLI chunk once it has been delivered to Elwood or held. */
  readonly output?: (data: string, output: HeldOutput) => void;
  /** Sees each string Elwood writes to the CLI, after the CLI has it. */
  readonly input?: (data: string, output: HeldOutput) => void;
};

/** Install a PTY factory whose output Elwood sees only while it is not held. */
export function holdCliOutput(hooks: OutputHoldHooks): void {
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    const handlers = new Set<(data: string) => void>();
    let held: string[] | undefined;
    const deliver = (data: string) => {
      for (const handler of handlers) handler(data);
    };
    const output: HeldOutput = {
      hold(ms, onRelease) {
        if (held !== undefined) return;
        held = [];
        setTimeout(() => {
          const chunks = held ?? [];
          held = undefined;
          onRelease?.();
          for (const chunk of chunks) deliver(chunk);
        }, ms);
      },
      get holding() {
        return held !== undefined;
      },
    };
    pty.onData((data) => {
      if (held === undefined) deliver(data);
      else held.push(data);
      hooks.output?.(data, output);
    });
    return {
      ...pty,
      onData(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      write(data) {
        pty.write(data);
        if (typeof data === "string") hooks.input?.(data, output);
      },
    };
  });
}

/**
 * Match `pattern` in the CLI's sanitized output with whitespace removed, since Codex draws
 * spaces as cursor moves. Each chunk is matched with a bounded raw carry from the ones
 * before it; once the pattern matches, the matcher stays matched and stops scanning.
 */
export function outputMatcher(pattern: RegExp): (data: string) => boolean {
  const plainText = createCliSanitizer();
  let carry = "";
  let found = false;
  return (data) => {
    if (found) return true;
    const raw = carry + data;
    found = pattern.test(plainText(raw).replace(/\s+/g, ""));
    carry = raw.slice(-carryLength);
    return found;
  };
}
