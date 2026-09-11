/**
 * Stable usage/configuration failure carried to the CLI boundary as status 2.
 * Implements PRD §12A.5 and C-CLI-17/C-CLI-20/C-CLI-21.
 */

export type CliValidationCode = "invalid_arguments" | "invalid_config" | "no_agent_found";

export class CliValidationError extends Error {
  override readonly name = "CliValidationError";
  readonly code: CliValidationCode;

  constructor(code: CliValidationCode, message: string) {
    super(message);
    this.code = code;
  }
}
