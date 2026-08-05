/**
 * The mechanical validator of a report document.
 *
 * The schemas already carry the grammar: a strict object rejects a forbidden field, a binding is present
 * by construction, and a metric value slot admits one scalar reference only. Thus a schema parse failure
 * is the grammar rejection, and the validator does not re-implement it. The validator adds the three
 * checks that a schema cannot make: it makes sure that each block id occurs one time only, it resolves
 * each reference against the pinned evidence, and it warns about a free numeral in prose.
 */

import { ReportDocumentSchema, type Block } from "../contracts/report-blocks.js";
import type { Reference, UnresolvedReference } from "../contracts/report-reference.js";
import type { ReferenceResolver, ReportSnapshot } from "./reference-resolver.js";

/** One schema conformance problem, reduced to a path and a message. */
export interface SchemaIssue {
    path: string;
    message: string;
}

/** One reference that did not resolve, tied to the block that carries it. */
export interface ResolutionFailure {
    blockId: string;
    failure: UnresolvedReference;
}

/** An advisory warning about the content of one block. A warning never makes a report invalid. */
export interface ReportWarning {
    blockId: string;
    kind: "free-numeral";
    detail: string;
}

/**
 * The result of validation. `valid` is false when the schema failed, a block id repeats, or a reference
 * did not resolve. `duplicateIds` names each repeated id one time, in sorted order. The warnings ride
 * along in either case.
 */
export type ReportValidation =
    | { valid: true; warnings: ReportWarning[] }
    | {
          valid: false;
          schemaIssues?: SchemaIssue[];
          duplicateIds?: string[];
          resolutionFailures?: ResolutionFailure[];
          warnings: ReportWarning[];
      };

/**
 * A token that looks like a number, with an optional decimal part and an optional percent sign.
 *
 * The check is advisory only. A natural-language numeral is brittle to police, because a numeral in
 * prose can be a real free-standing figure or a harmless part of a name. Thus a hit warns, and it never
 * fails the report.
 */
const NUMERAL_PATTERN = /-?\d+(?:\.\d+)?%?/g;

function numeralWarnings(blockId: string, prose: string): ReportWarning[] {
    const warnings: ReportWarning[] = [];
    for (const match of prose.matchAll(NUMERAL_PATTERN)) {
        warnings.push({ blockId, kind: "free-numeral", detail: match[0] });
    }
    return warnings;
}

/** Resolve each reference, collect the schema conformance and the resolution outcomes, and warn on prose. */
export async function validateReport(document: unknown, snapshot: ReportSnapshot, resolver: ReferenceResolver): Promise<ReportValidation> {
    const parsed = ReportDocumentSchema.safeParse(document);
    if (!parsed.success) {
        const schemaIssues: SchemaIssue[] = parsed.error.issues.map((issue) => ({
            path: issue.path.map((segment) => String(segment)).join("."),
            message: issue.message,
        }));
        return { valid: false, schemaIssues, warnings: [] };
    }

    const references: Array<{ blockId: string; reference: Reference }> = [];
    const warnings: ReportWarning[] = [];

    // An id is what makes a block addressable, thus an amend by id is well defined only while each id
    // belongs to one block. `seenIds` holds each id that the walk met, and `repeatedIds` holds each id
    // that it met again.
    const seenIds = new Set<string>();
    const repeatedIds = new Set<string>();

    const walk = (block: Block): void => {
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
                warnings.push(...numeralWarnings(block.id, block.content.prose));
                return;
            case "claim":
                warnings.push(...numeralWarnings(block.id, block.content.prose));
                for (const binding of block.bindings) {
                    references.push({ blockId: block.id, reference: binding });
                }
                return;
            case "metric":
                references.push({ blockId: block.id, reference: block.value });
                return;
            case "table":
            case "chart":
            case "figure":
                references.push({ blockId: block.id, reference: block.binding });
                return;
            case "citation":
                references.push({ blockId: block.id, reference: block.binding });
                return;
        }
    };

    for (const section of parsed.data.sections) {
        walk(section);
    }

    const resolved = await Promise.all(
        references.map(({ blockId, reference }) => resolver.resolve(reference, snapshot).then((result) => ({ blockId, result }))),
    );

    // Collect every failure. A reviewer must see each block that broke, thus the walk does not stop at
    // the first unresolved reference. The `Err` channel carries the unresolved reference itself.
    const resolutionFailures: ResolutionFailure[] = [];
    for (const { blockId, result } of resolved) {
        if (result.isErr()) {
            resolutionFailures.push({ blockId, failure: result.error });
        }
    }

    const duplicateIds = [...repeatedIds].sort();
    if (duplicateIds.length > 0 || resolutionFailures.length > 0) {
        return {
            valid: false,
            ...(duplicateIds.length > 0 ? { duplicateIds } : {}),
            ...(resolutionFailures.length > 0 ? { resolutionFailures } : {}),
            warnings,
        };
    }
    return { valid: true, warnings };
}
