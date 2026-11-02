/**
 * The documents and the snapshot that the report-session state and version suites share: one section with
 * one finding, and a snapshot that pins one output and cites one source.
 */

import type { DraftDocument } from "../../../report-model/draft.js";
import type { ReportDocument } from "../../../contracts/report-blocks.js";
import type { ReportSnapshot } from "../../../report-model/reference-resolver.js";

export const validDraftDocument: DraftDocument = {
    title: "A report",
    sections: [
        {
            kind: "section",
            id: "s1",
            title: "Findings",
            blocks: [{ kind: "text", id: "t1", content: { prose: "A finding." } }],
        },
    ],
};

export const validDocument: ReportDocument = {
    title: "A report",
    sections: [
        {
            kind: "section",
            id: "s1",
            title: "Findings",
            blocks: [{ kind: "text", id: "t1", content: { prose: "A finding." } }],
        },
    ],
};

export const citedSnapshot: ReportSnapshot = {
    artifacts: {
        "runs/r1/output/de.csv": { hash: "abc123", fileType: "output" },
    },
    citations: ["pmid:12345"],
};
