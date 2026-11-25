/** Track Claude trust menu appearances independently of published requests (C-ATTN-07). */
import type { TerminalSnapshot } from "../../terminal/headless.ts";
import type { ClaudeTrustAppearance } from "./answer.ts";
import type { WorkspaceTrustFrame } from "./menu.ts";

export class ClaudeTrustNativeAppearance {
  private current: ClaudeTrustAppearance | undefined;
  private counter = 0;

  sample(
    frame: TerminalSnapshot,
    candidate: WorkspaceTrustFrame | undefined,
  ): ClaudeTrustAppearance | undefined {
    const previous = this.current;
    if (previous?.frame === frame) return previous;
    this.current = candidate && {
      ...candidate,
      gateIdentity:
        previous?.identity === candidate.identity ? previous.gateIdentity : String(++this.counter),
    };
    return this.current;
  }

  clear(): void {
    this.current = undefined;
  }
}
