import { z } from "zod";

/**
 * The parsed form of a serialized PROV-JSON document, as the tests read it: each top-level
 * section maps its id to a flat record, and a section the document never wrote is absent —
 * the `undefined` value — rather than an empty object.
 */
export type ParsedProvJson = Record<string, Record<string, unknown> | undefined>;

/** Any JSON value — the leaf of every parsed PROV-JSON record. */
const jsonValue = z.lazy((): z.ZodType => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]));

const provJsonDocument = z.record(z.string(), z.record(z.string(), jsonValue).optional());

export function parseProvJson(raw: string): ParsedProvJson {
    return provJsonDocument.parse(JSON.parse(raw));
}

/** One section of a parsed document, typed as the id-to-flat-record map a relation section is. */
export function relationRecords(doc: ParsedProvJson, relation: string): Record<string, unknown>[] {
    const section = z.record(z.string(), z.record(z.string(), jsonValue)).parse(doc[relation] ?? {});
    return Object.values(section);
}
