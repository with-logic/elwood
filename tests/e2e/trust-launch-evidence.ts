/**
 * Per-launch evidence, keyed by each PTY's working directory (one fresh folder per
 * launch), that Claude displayed its folder-trust prompt and that Elwood answered it.
 * Without it a trust e2e can pass on a CLI that never showed the gate (C-E2E-09). An
 * answer's `startup_prompt` report must name a write the launch actually made.
 */

import { realpathSync } from "node:fs";
import { createCliSanitizer } from "../../src/cli/output/sanitize.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";

export type LaunchEvidence = {
  /** When the raw PTY output first showed the folder-trust prompt. */
  displayedAt: number | undefined;
  /** Every physical write the session made. */
  readonly writes: string[];
};

const home = "\u001b[H";
const down = "\u001b[B";

/**
 * An answer that carries its own absolute selection: a numbered option (`1\r`, the layout
 * Claude 2.1.206 renders) or a cursor selection anchored at Home (`\x1b[H\x1b[B\r`).
 */
export function isAbsoluteAnswer(input: string): boolean {
  if (/^\d+\r$/.test(input)) return true;
  if (!input.startsWith(home)) return false;
  const downs = input.slice(home.length).replace(/\r$/, "");
  return downs.split(down).every((between) => between === "");
}

export const isTrustInput = (input: string) =>
  ["\r", "\u001b[A", "\u001b[B"].some((key) => input.includes(key));

/** A write that confirmed the affirmative with its own absolute selection. */
export const isTrustAnswer = (input: string) => input.endsWith("\r") && isAbsoluteAnswer(input);

/** Each launch's `workspace_trust` `startup_prompt` reports, as `label: text`. */
export type TrustReports = string[];

const answerReport =
  /^workspace_trust: Detected claude workspace_trust prompt; sent (home(?:\+down)*\+enter|\d+)\.$/;

/** The physical write a folder-trust `startup_prompt` report names, if it is one. */
export function reportedTrustWrite(report: string): string | undefined {
  const input = answerReport.exec(report)?.[1];
  if (input === undefined) return undefined;
  if (/^\d+$/.test(input)) return `${input}\r`;
  return `${home}${down.repeat(input.split("+down").length - 1)}\r`;
}

/** Claude draws spaces as cursor moves, so the raw prompt is matched without them. */
const folderTrustOutput = /trustthisfolder|Isthisaprojectyou|Accessingworkspace:/i;
const plainText = createCliSanitizer();

/** Route every PTY through the real factory and record each launch folder's evidence. */
export function recordLaunchEvidence(): ReadonlyMap<string, LaunchEvidence> {
  const launches = new Map<string, LaunchEvidence>();
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    const folder = realpathSync(options.cwd);
    const evidence = launches.get(folder) ?? { displayedAt: undefined, writes: [] };
    launches.set(folder, evidence);
    let output = "";
    pty.onData((data) => {
      if (evidence.displayedAt !== undefined) return;
      output += data;
      const text = plainText(output).replace(/\s+/g, "");
      if (folderTrustOutput.test(text)) evidence.displayedAt = Date.now();
    });
    return {
      ...pty,
      write(data) {
        pty.write(data);
        evidence.writes.push(typeof data === "string" ? data : Buffer.from(data).toString());
      },
    };
  });
  return launches;
}
