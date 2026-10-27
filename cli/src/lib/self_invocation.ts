import { join } from "node:path";

import { env } from "./env.ts";

/**
 * The argv that runs this CLI again. A dev run has no compiled binary, so the `bun` runtime executes the
 * source entry; a release binary IS the `inflexa` executable. This file lives at `src/lib/`, thus the CLI
 * source entry is one level up.
 *
 * This module imports `env.ts` only: the entry runs itself again through it before any module opens the log
 * stream or starts a file call.
 */
export function selfInvocation(argv: readonly string[]): string[] {
    return env.isDevelopment ? [process.execPath, join(import.meta.dir, "../index.ts"), ...argv] : [process.execPath, ...argv];
}
