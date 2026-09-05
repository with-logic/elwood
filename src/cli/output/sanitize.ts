/**
 * Removes terminal control data and explicitly known runtime credentials from CLI text.
 * Implements PRD §12A.3 and C-CLI-12.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control-byte protocols.
const ansi = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/gu;
const csi = /\u009B[0-?]*[ -/]*[@-~]/gu;

/** Build a sanitizer whose secret list remains outside the serialized record model. */
export function createCliSanitizer(secrets: readonly string[] = []): (value: string) => string {
  const redactions = secrets.filter((secret) => secret.length > 0);
  return (value) => {
    let safe = value.replace(ansi, "").replace(csi, "");
    for (const secret of redactions) safe = safe.split(secret).join("[REDACTED]");
    return safe;
  };
}
