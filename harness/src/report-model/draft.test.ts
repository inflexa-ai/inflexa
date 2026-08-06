import { describe, expect, it } from "bun:test";

import { ReportDocumentSchema } from "../contracts/report-blocks.js";
import { DraftBlockSchema, DraftDocumentSchema, DraftSectionBlockSchema } from "./draft.js";

// A document that `ReportDocumentSchema` accepts. Each section holds at least one child, thus the
// contract admits it, and the draft must admit it too.
const fullDocument = {
    title: "Report",
    sections: [
        {
            kind: "section",
            id: "s1",
            title: "Intro",
            blocks: [{ kind: "text", id: "t1", content: { prose: "Body text." } }],
        },
    ],
};

describe("the draft grammar", () => {
    it("parses an empty draft with zero sections", () => {
        expect(DraftDocumentSchema.safeParse({ title: "Draft", sections: [] }).success).toBe(true);
    });

    it("parses an empty section with zero children", () => {
        const emptySection = { kind: "section", id: "s1", title: "Intro", blocks: [] };
        expect(DraftSectionBlockSchema.safeParse(emptySection).success).toBe(true);
    });

    it("refuses an atom with an extra field", () => {
        const textWithExtra = { kind: "text", id: "t1", content: { prose: "hello" }, extra: true };
        expect(DraftBlockSchema.safeParse(textWithExtra).success).toBe(false);
    });

    it("parses a nested empty section inside a section", () => {
        const nested = {
            kind: "section",
            id: "outer",
            title: "Outer",
            blocks: [{ kind: "section", id: "inner", title: "Inner", blocks: [] }],
        };
        expect(DraftSectionBlockSchema.safeParse(nested).success).toBe(true);
    });

    it("parses a full document that the contract accepts", () => {
        expect(ReportDocumentSchema.safeParse(fullDocument).success).toBe(true);
        expect(DraftDocumentSchema.safeParse(fullDocument).success).toBe(true);
    });
});
