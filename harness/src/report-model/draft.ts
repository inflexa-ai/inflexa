/**
 * The draft grammar of a report document under composition.
 *
 * An edit refuses what is wrong, and the finish refuses what is missing. Thus a draft permits emptiness,
 * and the contract does not. The draft admits an empty section list and an empty section, and the
 * completeness rules of `ReportDocumentSchema` gate one time, at the finish.
 *
 * The grammar composes from the contract atoms, and it does not copy them. The seven atom schemas keep
 * one definition, and the relaxed section is the only new part. Thus the draft never drifts from the
 * contract.
 *
 * The recursion mirrors `SectionBlockSchema`. The `blocks` field is a `z.lazy` and not a getter. Thus the
 * discriminated union reads the `kind` discriminator at construction time, and it needs no reference to
 * `DraftBlockSchema` before it exists. The relaxed rule holds at every depth, because a nested section is
 * a `DraftSectionBlock` too.
 */

import { z } from "zod";
import {
    ChartBlockSchema,
    CitationBlockSchema,
    ClaimBlockSchema,
    FigureBlockSchema,
    MetricBlockSchema,
    TableBlockSchema,
    TextBlockSchema,
} from "../contracts/report-blocks.js";

/**
 * The draft section shape as a plain type. TypeScript cannot infer the block tree through the union
 * cycle, thus the recursive members carry an explicit type. `DraftSectionBlock` and `DraftBlock` break
 * the cycle.
 */
export interface DraftSectionBlock {
    kind: "section";
    id: string;
    title: string;
    blocks: DraftBlock[];
}

/** One draft block of any of the eight kinds. The seven atoms keep the contract shape, and only the section relaxes. */
export type DraftBlock =
    | z.infer<typeof TextBlockSchema>
    | z.infer<typeof ClaimBlockSchema>
    | z.infer<typeof MetricBlockSchema>
    | z.infer<typeof TableBlockSchema>
    | z.infer<typeof ChartBlockSchema>
    | z.infer<typeof FigureBlockSchema>
    | z.infer<typeof CitationBlockSchema>
    | DraftSectionBlock;

/** A draft section permits zero child blocks, thus an empty section is a legal draft state. */
export const DraftSectionBlockSchema = z.strictObject({
    kind: z.literal("section"),
    id: z.string().min(1),
    title: z.string(),
    blocks: z.lazy(() => z.array(DraftBlockSchema)),
});

/** The draft block union. A `z.ZodType<DraftBlock>` annotation gives the recursive members a stable type. */
export const DraftBlockSchema: z.ZodType<DraftBlock> = z.discriminatedUnion("kind", [
    DraftSectionBlockSchema,
    TextBlockSchema,
    ClaimBlockSchema,
    MetricBlockSchema,
    TableBlockSchema,
    ChartBlockSchema,
    FigureBlockSchema,
    CitationBlockSchema,
]);

/** The root of a draft. It permits zero sections, thus an empty draft is a legal state. */
export const DraftDocumentSchema = z.strictObject({
    title: z.string(),
    sections: z.array(DraftSectionBlockSchema),
});

export type DraftDocument = z.infer<typeof DraftDocumentSchema>;
