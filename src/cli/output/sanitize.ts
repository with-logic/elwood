/**
 * Removes terminal control data and explicitly known runtime credentials from CLI text.
 * Implements PRD §12A.3 and C-CLI-12.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC is a control-byte protocol.
const osc = /(?:\u001B\]|\u009D)(?:(?!\u001B\\)[^\u0007\u009C])*(?:\u0007|\u009C|\u001B\\)/gu;
const csi = /\u009B[0-?]*[ -/]*[@-~]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control-byte protocols.
const ansi = /\u001B(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[0-~])/gu;
// Keep only tab and LF. CR is terminal-affecting and the CLI protocol uses LF for line breaks.
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing output controls is the point.
const terminalControls = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/** Build a sanitizer whose secret list remains outside the serialized record model. */
export function createCliSanitizer(secrets: readonly string[] = []): (value: string) => string {
  const redactions = secrets.filter((secret) => secret.length > 0);
  return (value) => {
    let safe = value.replace(osc, "").replace(csi, "").replace(ansi, "");
    safe = safe.replace(terminalControls, "");
    for (const secret of redactions) safe = safe.split(secret).join("[REDACTED]");
    return safe;
  };
}
