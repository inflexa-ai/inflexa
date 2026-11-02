/**
 * The pinned output that the draft suites share: one `de.csv` of run 1 inside the snapshot, and the path of a
 * later run that the snapshot holds no entry for.
 */

import type { ReportSnapshot } from "../../reference-resolver.js";

export const OUTPUT_PATH = "runs/run-1/step-a/output/de.csv";
export const OUTPUT_HASH = `sha256:${"a".repeat(64)}`;
// The output of a later run. The snapshot froze before that run, thus it holds no entry for this path.
export const ABSENT_PATH = "runs/run-2/step-a/output/later.csv";
export const ABSENT_HASH = `sha256:${"3".repeat(64)}`;

/** The snapshot that holds the pinned output, as the served membership gives it. */
export const pinnedSnapshot: ReportSnapshot = {
    artifacts: {
        [OUTPUT_PATH]: { hash: OUTPUT_HASH, fileType: "output" },
    },
};
