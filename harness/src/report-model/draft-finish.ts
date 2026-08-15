/**
 * The finish of a draft.
 *
 * An edit refuses what is wrong. The finish refuses what is missing. Thus the finish gates the whole
 * draft one time: the full document schema, the unique ids, and the structural tier over every reference.
 *
 * The finish opens no file, and it reads the snapshot alone. Thus it runs the structural tier only, and
 * the value tier stays in the gate of the report pipeline. The structural tier matches the columns of a
 * chart wherever the snapshot can answer, and the value tier matches them again over the rows that it
 * reads.
 *
 * The free-numeral scan needs no file, thus the finish runs it and reports each hit as a warning. A
 * warning never makes a draft invalid, and it rides beside the outcome in either case. Without the
 * channel a caller could not read the one signal that catches a figure typed into prose with no metric
 * block behind it.
 *
 * The result is plain data. A gap is an expected outcome, not an error, thus the finish never throws. On
 * a pass the finish gives the valid document, and it does not change the draft.
 */

import { ReportDocumentSchema, type ReportDocument } from "../contracts/report-blocks.js";
import type { UnresolvedReference } from "../contracts/report-reference.js";
import { walkBlocks, type ReportWarning } from "./block-walk.js";
import type { DraftDocument } from "./draft.js";
import type { ReportSnapshot } from "./reference-resolver.js";
import { validateReferenceStructure } from "./structural-validation.js";

/** A schema conformance gap, reduced to a path and a message. */
export interface SchemaGap {
    kind: "schema";
    path: string;
    message: string;
}

/** A duplicate id gap. More than one block holds the id. */
export interface DuplicateIdGap {
    kind: "duplicate-id";
    id: string;
}

/** An unresolved reference gap. It ties the block that carries the reference to the reason it did not resolve. */
export interface UnresolvedReferenceGap {
    kind: "unresolved-reference";
    blockId: string;
    failure: UnresolvedReference;
}

/** One completeness gap of a draft. The kind set is closed. */
export type FinishGap = SchemaGap | DuplicateIdGap | UnresolvedReferenceGap;

/**
 * The finish result. On a pass it gives the valid document. On a fail it gives each gap. The warnings
 * ride along in either case, because a warning is advisory and it never decides the outcome.
 */
export type FinishResult =
    { valid: true; document: ReportDocument; warnings: ReportWarning[] } | { valid: false; gaps: FinishGap[]; warnings: ReportWarning[] };

/**
 * Finish a draft. The finish validates the schema, the unique ids, and the structural resolution of each
 * reference, and it reports each gap as data. It warns about each free numeral in prose.
 */
export function finishDraft(draft: DraftDocument, snapshot: ReportSnapshot): FinishResult {
    const gaps: FinishGap[] = [];

    const parsed = ReportDocumentSchema.safeParse(draft);
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            gaps.push({
                kind: "schema",
                path: issue.path.map((segment) => String(segment)).join("."),
                message: issue.message,
            });
        }
    }

    // The walk reads the draft tree, not the parse result. The draft is already typed, thus the walk stays
    // well-defined even when the schema parse fails, and a caller still gets the id and reference gaps.
    const { references, repeatedIds, warnings } = walkBlocks(draft.sections);

    for (const id of repeatedIds) {
        gaps.push({ kind: "duplicate-id", id });
    }

    for (const entry of references) {
        const result = validateReferenceStructure(entry.reference, snapshot, entry.encodingColumns);
        if (result.isErr()) {
            gaps.push({ kind: "unresolved-reference", blockId: entry.blockId, failure: result.error });
        }
    }

    // A schema failure always pushes a gap. Thus an empty gap list means the parse passed. The
    // `parsed.success` test also narrows the type for the document return.
    if (!parsed.success || gaps.length > 0) {
        return { valid: false, gaps, warnings };
    }
    return { valid: true, document: parsed.data, warnings };
}
