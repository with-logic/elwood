/**
 * The one promise-returning sleep used by the TUI automation flows (model picker
 * polling, cursor trust navigation). Implements PRD §5.3: a plain referenced timer,
 * so an automation step that is mid-wait keeps the process alive until it settles.
 */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
