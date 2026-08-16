/**
 * The one parse of a stored report snapshot, shared by the two stores.
 *
 * The session-state store and the version store each hold a snapshot column, and
 * each reads it back the same way. A path such as `__proto__` is an ordinary
 * artifact key of the ledger, and the pin keeps it as an own member of a
 * null-prototype map (`report-model/pin-snapshot.ts`). Each object-shaped schema
 * of zod drops such a key, thus a store that parsed the map through one would
 * resolve a reference to that artifact before a reload and refuse it as absent
 * after one. The walk reads the own keys of the stored map, and it parses each
 * value on its own, thus the two stores agree on the key set.
 */

import { type Result, err, ok } from "neverthrow";
import { z } from "zod";

import type { ArtifactSnapshot, ReportSnapshot } from "../report-model/reference-resolver.js";

/** One reduced schema issue -- the dotted path and the message, without the rest. */
export interface SchemaIssue {
    readonly path: string;
    readonly message: string;
}

/**
 * One pinned artifact of a stored snapshot. The value carries the content hash, an
 * optional file type, and optional rows.
 */
const ArtifactSnapshotSchema = z.object({
    hash: z.string(),
    fileType: z.string().nullable().optional(),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).optional(),
});

/** The citation list of a stored snapshot. A snapshot with no list reads as an absent field. */
const CitationsSchema = z.array(z.string()).optional();

/**
 * The citation records of a stored snapshot, keyed by the citation key. A snapshot with no map reads as
 * an absent field, thus a pin that predates the map loads the same as it did before.
 */
const CitationRecordsSchema = z.record(z.string(), z.object({ citation: z.string(), description: z.string().optional() })).optional();

/** Reduce a zod error to the dotted path and the message of each issue. */
export function reduceIssues(error: z.ZodError): SchemaIssue[] {
    return error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        message: issue.message,
    }));
}

/** Put a prefix before the path of each issue, thus a nested parse names the key that failed. */
function prefixIssues(prefix: string, issues: SchemaIssue[]): SchemaIssue[] {
    return issues.map((issue) => ({
        path: issue.path === "" ? prefix : `${prefix}.${issue.path}`,
        message: issue.message,
    }));
}

/** A stored map is a plain object. An array and a null carry no own key that a map read can use. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a stored snapshot.
 *
 * The artifacts map never goes through a zod object schema, for the reason that
 * the module header gives: a zod object drops a `__proto__` key and the pin keeps
 * it. The walk reads the own keys of the stored map, and it parses each value on
 * its own.
 *
 * The `ReportSnapshot` return type ties this parse to the type of the reference
 * model, thus a change to one shows as a compile error here.
 */
export function parseSnapshot(stored: unknown): Result<ReportSnapshot, SchemaIssue[]> {
    if (!isPlainRecord(stored)) {
        return err([{ path: "", message: "the stored snapshot is not an object" }]);
    }
    if (!isPlainRecord(stored.artifacts)) {
        return err([{ path: "artifacts", message: "the artifacts map is not an object" }]);
    }
    const citations = CitationsSchema.safeParse(stored.citations);
    if (!citations.success) {
        return err(prefixIssues("citations", reduceIssues(citations.error)));
    }
    const citationRecords = CitationRecordsSchema.safeParse(stored.citationRecords);
    if (!citationRecords.success) {
        return err(prefixIssues("citationRecords", reduceIssues(citationRecords.error)));
    }
    // The map takes a null prototype, the same as the pin, thus a path such as
    // `__proto__` stays an ordinary entry and never reaches a prototype slot.
    const artifacts: Record<string, ArtifactSnapshot> = Object.create(null);
    const issues: SchemaIssue[] = [];
    for (const [path, value] of Object.entries(stored.artifacts)) {
        const parsed = ArtifactSnapshotSchema.safeParse(value);
        if (!parsed.success) {
            issues.push(...prefixIssues(`artifacts.${path}`, reduceIssues(parsed.error)));
            continue;
        }
        artifacts[path] = parsed.data;
    }
    if (issues.length > 0) {
        return err(issues);
    }
    // An absent part stays absent in the parsed value. Thus a reload gives the same shape that the pin
    // wrote, and an equality test over a stored snapshot holds across the round trip.
    return ok({
        artifacts,
        ...(citations.data === undefined ? {} : { citations: citations.data }),
        ...(citationRecords.data === undefined ? {} : { citationRecords: citationRecords.data }),
    });
}
