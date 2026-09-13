/**
 * Strict client-message validation for the browser dev app.
 * Covers PRD §11 (C-APP-08): malformed or unknown control frames are rejected
 * with a clear error and can never be mistaken for a valid message (in
 * particular, an unknown type must NOT reach teardown).
 */

import { describe, expect, test } from "vitest";
import { parseClientMessage } from "../../dev/web/parse.ts";

describe("client message validation", () => {
  test("C-APP-08 accepts each well-formed variant", () => {
    expect(parseClientMessage('{"type":"stop"}')).toEqual({ type: "stop" });
    expect(parseClientMessage('{"type":"kill"}')).toEqual({ type: "kill" });
    expect(parseClientMessage('{"type":"teardown"}')).toEqual({ type: "teardown" });
    expect(parseClientMessage('{"type":"prompt","value":"hi"}')).toEqual({
      type: "prompt",
      value: "hi",
    });
    expect(parseClientMessage('{"type":"keys","value":"\\u0003"}')).toEqual({
      type: "keys",
      value: "",
    });
    expect(parseClientMessage('{"type":"resize","cols":80,"rows":24}')).toEqual({
      type: "resize",
      cols: 80,
      rows: 24,
    });
  });

  test("C-APP-08 accepts a start with required and optional fields", () => {
    expect(
      parseClientMessage(
        '{"type":"start","agent":"codex","cwd":"/w","cols":80,"rows":24,"stateDir":"/s","elwoodSessionId":"e1"}',
      ),
    ).toEqual({
      type: "start",
      agent: "codex",
      cwd: "/w",
      cols: 80,
      rows: 24,
      stateDir: "/s",
      elwoodSessionId: "e1",
    });
    expect(parseClientMessage('{"type":"start","cwd":"/w","cols":80,"rows":24}')).toEqual({
      type: "start",
      cwd: "/w",
      cols: 80,
      rows: 24,
    });
  });

  test("C-APP-08 rejects non-JSON and non-object frames with distinct messages", () => {
    // Invalid JSON, a non-object, and an object missing `type` each get a distinct
    // descriptive error (the parser promises descriptive errors for the dev app).
    expect(() => parseClientMessage("not json")).toThrow("Client message is not valid JSON.");
    expect(() => parseClientMessage("null")).toThrow("Client message must be a JSON object.");
    expect(() => parseClientMessage("42")).toThrow("Client message must be a JSON object.");
    expect(() => parseClientMessage("{}")).toThrow(
      'Client message requires a string "type" field.',
    );
  });

  test("C-APP-08 rejects an unknown type instead of falling through to teardown", () => {
    // A near-miss typo of "teardown" must NOT tear the session down.
    expect(() => parseClientMessage('{"type":"tearwdown"}')).toThrow(
      "Unknown client message type: tearwdown",
    );
    expect(() => parseClientMessage('{"type":"nope"}')).toThrow(
      "Unknown client message type: nope",
    );
  });

  test("C-APP-08 rejects missing or mistyped required fields", () => {
    expect(() => parseClientMessage('{"type":"prompt"}')).toThrow(
      'prompt message requires string "value".',
    );
    expect(() => parseClientMessage('{"type":"keys","value":5}')).toThrow(
      'keys message requires string "value".',
    );
    expect(() => parseClientMessage('{"type":"resize","cols":80}')).toThrow(
      'resize message requires numeric "rows".',
    );
    expect(() => parseClientMessage('{"type":"resize","cols":"x","rows":24}')).toThrow(
      'resize message requires numeric "cols".',
    );
    expect(() => parseClientMessage('{"type":"start","cols":80,"rows":24}')).toThrow(
      'start message requires string "cwd".',
    );
    expect(() => parseClientMessage('{"type":"start","cwd":"/w","cols":"x","rows":24}')).toThrow(
      'start message requires numeric "cols".',
    );
  });

  test("C-APP-08 rejects mistyped optional start fields", () => {
    expect(() =>
      parseClientMessage('{"type":"start","cwd":"/w","cols":80,"rows":24,"agent":"gemini"}'),
    ).toThrow('start message "agent" must be "claude" or "codex".');
    expect(() =>
      parseClientMessage('{"type":"start","cwd":"/w","cols":80,"rows":24,"stateDir":5}'),
    ).toThrow('start message "stateDir" must be a string.');
    expect(() =>
      parseClientMessage('{"type":"start","cwd":"/w","cols":80,"rows":24,"elwoodSessionId":5}'),
    ).toThrow('start message "elwoodSessionId" must be a string.');
    expect(() => parseClientMessage('{"type":"resize","cols":80,"rows":"NaN"}')).toThrow(
      'resize message requires numeric "rows".',
    );
  });
});
