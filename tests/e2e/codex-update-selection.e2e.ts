/**
 * Captured Codex update option layouts replayed through a real PTY (C-CODEX-12).
 * docs/cli-behavior.md records 0.132/0.133's labels; the banner uses the measured
 * 0.151.0 -> 0.152.0 form. This is layout replay, not a live Codex update event.
 * The child receives and acknowledges physical input; no writes-array oracle.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node-pty";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { guardedCodexAutomationWrite } from "../../src/codex/update-prompt.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

const childProgram = `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.once('data', (data) => {
  process.stdout.write('\\x1b[2J\\x1b[HCHILD_RECEIVED_HEX:' + data.toString('hex') + ':END\\r\\n');
});
process.stdout.write(process.argv[1]);
`;

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await delay(10);
  if (!check()) throw new Error(message);
}

for (const scenario of [
  {
    name: "captured option order",
    rows: "1. Update now\n2. Skip\n3. Skip until next version",
    key: "2",
  },
  { name: "adversarial pre-action skip", rows: "1. Skip\n2. Update now\n3. Skip", key: "3" },
]) {
  test(`C-CODEX-12 ${scenario.name} sends the safe digit across the PTY`, {
    timeout: 15_000,
  }, async () => {
    const frame = `Update available! 0.151.0 -> 0.152.0\n${scenario.rows}`;
    const paint = `\u001b[2J\u001b[H${frame.replaceAll("\n", "\r\n")}`;
    const child = spawn(process.execPath, ["-e", childProgram, paint], {
      cwd: process.cwd(),
      env: process.env,
      cols: 100,
      rows: 30,
    });
    const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, (input) =>
      child.write(typeof input === "string" ? input : Buffer.from(input)),
    );
    const responder = new CodexStartupPromptResponder("captured-update");
    let rendered = Promise.resolve();
    let exited = false;
    let acknowledgement = "";
    let received = "";
    const exit = child.onExit(() => {
      exited = true;
    });
    const output = child.onData((data) => {
      received += data;
      acknowledgement = /CHILD_RECEIVED_HEX:([0-9a-f]+):END/.exec(received)?.[1] ?? "";
      rendered = rendered.then(() => terminal.writeOutput(data));
    });
    try {
      await until(
        () => terminal.snapshot().text.includes(scenario.rows.split("\n").at(-1)!),
        "all option rows rendered",
      );
      await rendered;
      assert.ok(terminal.snapshot().text.includes("Update available!"));
      const read = () => terminal.snapshot().text;
      const send = (input: string) => terminal.sendInput(input);
      const guarded = guardedCodexAutomationWrite(terminal, send, read);
      const result = responder.handle(read(), send, read, guarded);
      assert.equal(result.outcomes[0]?.outcome.kind, "attempted");
      await until(() => acknowledgement !== "", "child acknowledged a physical key");
      await rendered;
      await Promise.all(result.outcomes.map((outcome) => outcome.settled));
      assert.equal(Buffer.from(acknowledgement, "hex").toString(), scenario.key);
    } finally {
      responder.dispose();
      child.kill("SIGKILL");
      await until(() => exited, "PTY child exited during cleanup");
      output.dispose();
      exit.dispose();
      await rendered;
      terminal.dispose();
    }
  });
}
