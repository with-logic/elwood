/**
 * The login shells the e2e CLI home guard's tests run in (PRD §12, C-E2E-24): zsh and bash,
 * whichever this machine has, so both guard suites cover the same shells.
 */

import { existsSync } from "node:fs";

export const loginShells = ["/bin/zsh", "/bin/bash"].filter((shell) => existsSync(shell));
