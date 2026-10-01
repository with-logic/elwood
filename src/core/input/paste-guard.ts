/** Native staged-input, empty-frame and retry-authority contracts (PRD §5.3, C-API-56). */
import type { EmptyComposerObserver } from "./clear-ack.ts";

/** Native adapters prepare one staged-input predicate for each recovery sequence. */
export type RecoveryComposer = {
  readonly prepareStaged: (payload: string) => () => boolean;
  readonly emptyFrame: EmptyComposerObserver;
};

/** Adapter view of "the paste is still staged in the composer". */
export type PasteGuard = {
  /** Private completed-render notification; listeners are removed when awaited input settles. */
  readonly subscribeRender?: (listener: () => void) => () => void;
  /** Capture caller ownership before the initial Enter, never recovery retries. */
  readonly beforeEnter?: () => void;
  /** Captured immediately before Enter; true only after later received output is rendered. */
  readonly captureRenderProgress?: () => () => boolean;
  /** Capture before paste/Enter: watches later native submission activity. */
  readonly captureRecovery?: () => { readonly revoked: () => boolean };
  /** Reuse a token per completed empty frame; only a later frame gets a new identity. */
  readonly emptyFrame?: EmptyComposerObserver;
  /**
   * True when a human or automation-owned dialog is on screen. A dialog can
   * appear during the paste-settle window; sending the submitting Enter then
   * would confirm the dialog's highlighted option (e.g. approve a tool). The
   * Enter is therefore held while this is true and retried once it clears.
   */
  readonly blocked?: () => boolean;
} & (
  | Pick<RecoveryComposer, "prepareStaged">
  | {
      readonly snapshot: () => string;
      /** Legacy write-only guards receive the sanitized payload on each observation. */
      readonly staged: (screen: string, payload: string) => boolean;
    }
);
