/**
 * Terminal protocol replies Elwood's headless terminal sends a CLI in answer to the CLI's
 * own queries: cursor position, device attributes, and mode and status reports. They are
 * not application input, so the e2e input guards forward them (PRD §12). Codex 0.171 and
 * 0.172 ask for mode and status reports as well as the cursor and device attributes.
 */

const reply = /^\[(?:\d+;\d+R|\?[\d;]+c|\?[\d;]+\$y|[\d;]*n)$/;

export function isTerminalProtocolReply(input: string): boolean {
  return input.startsWith("\u001b") && reply.test(input.slice(1));
}
