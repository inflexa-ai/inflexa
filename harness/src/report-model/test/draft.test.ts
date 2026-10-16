import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { ATOM_BLOCK_SCHEMAS, ReportDocumentSchema } from "../../contracts/report-blocks.js";
import { DraftBlockSchema, DraftDocumentSchema, DraftSectionBlockSchema } from "../draft.js";

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

    it("admits every atom kind that the contract declares", () => {
        // The draft spreads the same atom tuple as the contract union. A ninth kind that lands in the
        // contract and not here would be unauthorable, and nothing in the build would say so.
        const contractKinds = ATOM_BLOCK_SCHEMAS.map((schema) => schema.shape.kind.value);
        // `DraftBlockSchema` is annotated as the bare `ZodType` for its own recursion, which erases
        // `options`; the runtime value is the discriminated union built one line above the annotation,
        // and the parse reads it with that shape at runtime.
        const options = z
            .array(z.looseObject({ shape: z.looseObject({ kind: z.looseObject({ value: z.string() }) }) }))
            .parse(Reflect.get(DraftBlockSchema, "options"));
        const draftKinds = options.map((option) => option.shape.kind.value);

        expect(draftKinds.sort()).toEqual([...contractKinds, "section"].sort());
    });
});
