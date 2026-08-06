/**
 * The finish of a draft.
 *
 * An edit refuses what is wrong. The finish refuses what is missing. Thus the finish gates the whole
 * draft one time: the full document schema, the unique ids, and the structural tier over every reference.
 *
 * The finish opens no file, and it reads the snapshot alone. Thus it runs the structural tier only, and
 * the value tier stays in the gate of the report pipeline.
 *
 * The result is plain data. A gap is an expected outcome, not an error, thus the finish never throws. On
 * a pass the finish gives the valid document, and it does not change the draft.
 */

import { ReportDocumentSchema, type ReportDocument } from "../contracts/report-blocks.js";
import type { Reference, UnresolvedReference } from "../contracts/report-reference.js";
import type { DraftBlock, DraftDocument } from "./draft.js";
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

/** The finish result. On a pass it gives the valid document. On a fail it gives each gap. */
export type FinishResult = { valid: true; document: ReportDocument } | { valid: false; gaps: FinishGap[] };

/** One reference that the walk met, tied to the block that carries it. */
interface CollectedReference {
    blockId: string;
    reference: Reference;
}

/**
 * Finish a draft. The finish validates the schema, the unique ids, and the structural resolution of each
 * reference, and it reports each gap as data.
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

    // The id scan and the reference walk read the draft tree. The draft is already typed, thus the walk
    // stays well-defined even when the schema parse fails.
    const seenIds = new Set<string>();
    const repeatedIds = new Set<string>();
    const references: CollectedReference[] = [];

    const walk = (block: DraftBlock): void => {
        if (seenIds.has(block.id)) {
            repeatedIds.add(block.id);
        } else {
            seenIds.add(block.id);
        }
        switch (block.kind) {
            case "section":
                for (const child of block.blocks) {
                    walk(child);
                }
                return;
            case "text":
                return;
            case "claim":
                for (const binding of block.bindings) {
                    references.push({ blockId: block.id, reference: binding });
                }
                return;
            case "metric":
                references.push({ blockId: block.id, reference: block.value });
                return;
            case "chart":
            case "table":
            case "figure":
            case "citation":
                references.push({ blockId: block.id, reference: block.binding });
                return;
        }
    };

    for (const section of draft.sections) {
        walk(section);
    }

    for (const id of [...repeatedIds].sort()) {
        gaps.push({ kind: "duplicate-id", id });
    }

    for (const entry of references) {
        const result = validateReferenceStructure(entry.reference, snapshot);
        if (result.isErr()) {
            gaps.push({ kind: "unresolved-reference", blockId: entry.blockId, failure: result.error });
        }
    }

    // A schema failure always pushes a gap. Thus an empty gap list means the parse passed. The
    // `parsed.success` test also narrows the type for the document return.
    if (!parsed.success || gaps.length > 0) {
        return { valid: false, gaps };
    }
    return { valid: true, document: parsed.data };
}
