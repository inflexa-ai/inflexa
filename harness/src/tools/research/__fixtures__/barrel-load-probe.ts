/**
 * Runs in a pristine child Bun process: loads the public barrel, then reports whether the agent factory arrived and
 * what `os.availableParallelism()` answers. The regression test spawns this file because a barrel that imports
 * `pdf-parse` statically breaks `os` for the whole process, and the test runner shares one process with the PDF
 * extraction tests, which load `pdf-parse` lazily and legitimately.
 */

import { errorMessageOf } from "../../../lib/thrown.js";
import { textOf } from "../../../lib/unknown-text.js";

const probe = async (): Promise<void> => {
    const os = await import("node:os");
    const harness = await import("../../../index.js");
    const parallelism = os.availableParallelism();
    process.stdout.write(
        JSON.stringify({
            agent: typeof harness.createConversationAgent === "function",
            parallelism: Number.isFinite(parallelism) ? parallelism : "undefined",
        }),
    );
};

probe().catch((error: unknown) => {
    process.stderr.write(errorMessageOf(error) ?? textOf(error));
    process.exit(1);
});
