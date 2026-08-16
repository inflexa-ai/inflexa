/**
 * The mechanical validator of a report document.
 *
 * The schemas already carry the grammar: a strict object rejects a forbidden field, a binding is present
 * by construction, and a metric value slot admits one scalar reference only. Thus a schema parse failure
 * is the grammar rejection, and the validator does not re-implement it. The validator adds the three
 * checks that a schema cannot make: it makes sure that each block id occurs one time only, it resolves
 * each reference against the pinned evidence, and it warns about the prose of each block.
 */

import { ReportDocumentSchema } from "../contracts/report-blocks.js";
import type { UnresolvedReference } from "../contracts/report-reference.js";
import { allWithConcurrency } from "../lib/async-utils.js";
import { walkBlocks, type AnyBlock, type CollectedReference, type ReportWarning } from "./block-walk.js";
import { columnsHeldByNoRow, type ReferenceResolver, type ReportSnapshot, type ResolvedValue } from "./reference-resolver.js";

export type { ReportWarning };

/**
 * The cap on how many references resolve at the same time.
 *
 * A production resolver reads storage for each reference, and a large report holds hundreds of them. An
 * unbounded fan-out would open one read for each reference at the same moment.
 */
export const RESOLUTION_CONCURRENCY = 8;

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
 * Match each column that a chart encoding names against the table that its binding resolved to.
 *
 * The binding schema admits a table reference only, thus a resolved value of another type means that the
 * bound resolver broke its own contract. That is reported and never ignored, because a chart with no
 * table behind it renders nothing and a silent skip would pass it as grounded.
 */
export function checkChartEncoding(entry: CollectedReference, value: ResolvedValue): UnresolvedReference | undefined {
    const encodingColumns = entry.encodingColumns;
    if (encodingColumns === undefined || encodingColumns.length === 0) {
        return undefined;
    }
    if (value.type !== "table") {
        return { reference: entry.reference, reason: "locator-out-of-range", detail: `the chart binding resolved to a ${value.type} and not to a table` };
    }
    const absent = columnsHeldByNoRow(value.rows, encodingColumns);
    if (absent.length === 0) {
        return undefined;
    }
    return {
        reference: entry.reference,
        reason: "locator-out-of-range",
        detail: `the encoding names column ${absent.join(", ")}, which the bound table does not hold`,
    };
}

/** The resolved values and the failures of one resolution pass over the references of a block tree. */
export interface ReferenceResolution {
    /** The resolved value of each block whose reference resolved, keyed by its block id. */
    resolvedByBlock: Map<string, ResolvedValue>;
    /** Each reference that did not resolve, or whose chart encoding named an absent column. */
    failures: ResolutionFailure[];
}

/**
 * Resolve each reference of a block tree under the concurrency bound, and run the chart-encoding match.
 *
 * The walk collects each reference one time, `allWithConcurrency` bounds the fan-out, and
 * `checkChartEncoding` catches a chart that plots a column which the bound table does not hold. The record
 * gate and the preview share this one pass, thus the two refuse the same references. A value-bearing block
 * whose reference resolved carries its value in the map. A claim or a citation reference reads no value
 * from the map. The walk collects every failure, thus a reviewer sees each block that broke.
 */
export async function resolveDocumentReferences(
    sections: readonly AnyBlock[],
    snapshot: ReportSnapshot,
    resolver: ReferenceResolver,
): Promise<ReferenceResolution> {
    const { references } = walkBlocks(sections);

    // A realization that reads storage batches its reads here, one time before the loop. It fills a cache
    // that each `resolve` then answers from. A realization without `prepare` keeps the per-reference read.
    if (resolver.prepare !== undefined) {
        await resolver.prepare(
            references.map((entry) => entry.reference),
            snapshot,
        );
    }

    const resolved = await allWithConcurrency(
        references.map((entry) => () => resolver.resolve(entry.reference, snapshot).then((result) => ({ entry, result }))),
        RESOLUTION_CONCURRENCY,
    );

    const failures: ResolutionFailure[] = [];
    const resolvedByBlock = new Map<string, ResolvedValue>();
    for (const { entry, result } of resolved) {
        if (result.isErr()) {
            failures.push({ blockId: entry.blockId, failure: result.error });
            continue;
        }
        const encodingFailure = checkChartEncoding(entry, result.value);
        if (encodingFailure !== undefined) {
            failures.push({ blockId: entry.blockId, failure: encodingFailure });
            continue;
        }
        resolvedByBlock.set(entry.blockId, result.value);
    }
    return { resolvedByBlock, failures };
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

    const { repeatedIds, warnings } = walkBlocks(parsed.data.sections);
    const { failures: resolutionFailures } = await resolveDocumentReferences(parsed.data.sections, snapshot, resolver);

    if (repeatedIds.length > 0 || resolutionFailures.length > 0) {
        return {
            valid: false,
            ...(repeatedIds.length > 0 ? { duplicateIds: repeatedIds } : {}),
            ...(resolutionFailures.length > 0 ? { resolutionFailures } : {}),
            warnings,
        };
    }
    return { valid: true, warnings };
}
