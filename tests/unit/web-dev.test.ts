/** Focused unit coverage for browser dev app assets and message parsing. Covers PRD §9 and §10. */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { clientScript, renderHtml } from "../../src/app/web-assets.ts";
import { parseClientMessage, sizeFrom } from "../../src/app/web-messages.ts";

describe("browser dev app helpers", () => {
  test("C-APP-08 renders the shell and client script", () => {
    expect(renderHtml("/tmp/project")).toContain('value="/tmp/project"');
    expect(renderHtml("/tmp/project")).toContain('value="codex"');
    expect(renderHtml("/tmp/project")).toContain("/client.js");
    expect(renderHtml('/tmp/"project"')).toContain('value="/tmp/&quot;project&quot;"');
    expect(clientScript()).toContain("new Terminal");
    expect(clientScript()).toContain("agent:");
    expect(clientScript()).toContain('send({ type: "resize"');
    expect(clientScript()).toContain('send({ type: "stop"');
    expect(clientScript()).toContain('send({ type: "teardown"');
  });

  test("C-APP-10 renders structured debugger controls", () => {
    const html = renderHtml("/tmp/project");
    expect(html).toContain('id="events"');
    expect(html).toContain('id="detail-json"');
    expect(html).toContain('data-filter="hook"');
    expect(clientScript()).toContain('if (message.type === "event") addEvent(message.entry)');
    expect(clientScript()).toContain("(entry.tags || []).includes(activeFilter)");
    expect(clientScript()).toContain("function renderDetail");
  });

  test("C-APP-08 parses client messages and terminal sizes", () => {
    expect(parseClientMessage('{"type":"kill"}')).toEqual({ type: "kill" });
    expect(parseClientMessage('{"type":"stop"}')).toEqual({ type: "stop" });
    expect(parseClientMessage('{"type":"teardown"}')).toEqual({ type: "teardown" });
    expect(
      parseClientMessage('{"type":"start","agent":"codex","cwd":".","cols":80,"rows":24}'),
    ).toMatchObject({ agent: "codex", cwd: ".", cols: 80, rows: 24 });
    expect(sizeFrom({ cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(() => parseClientMessage("null")).toThrow("Invalid client message.");
  });

  test("C-APP-08 keeps shutdown handling outside the web server body", () => {
    const source = readFileSync(new URL("../../src/app/web-dev.ts", import.meta.url), "utf8");
    const dispatch = readFileSync(
      new URL("../../src/app/web-dispatch.ts", import.meta.url),
      "utf8",
    );
    const supervisor = readFileSync(new URL("../../scripts/dev-web.ts", import.meta.url), "utf8");
    expect(source).not.toContain("setRawMode");
    expect(source).not.toContain("process.stdin");
    expect(source).not.toContain("terminal.snapshot");
    expect(dispatch).toContain('active.on("terminal:data"');
    expect(supervisor).toContain('spawn("node"');
  });
});
