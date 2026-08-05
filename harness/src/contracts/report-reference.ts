/**
 * A reference binds a report block to the evidence that justifies it. It is the one canonical way a
 * block points at a value, a table, a derived quantity, or an external source.
 *
 * The reference lives here, in `contracts/`, because a consumer reads it back after a run. The consumer
 * imports this module without the harness's own dependencies, thus it holds a reference as plain data.
 *
 * Resolution reads the evidence again at render time. The `assert` field is the authored belief, and
 * the resolver matches the fresh read against it.
 */

import { z } from "zod";

/**
 * The shape of a content hash, as `algorithm:hex`, for example `sha256:9f86d0...`. The resolver
 * compares this text against a fresh read, thus the exact string must survive a round trip.
 */
const HASH_PATTERN = /^[a-z0-9]+:[0-9a-f]+$/i;

/**
 * The pin that ties an artifact reference to one immutable file. It names the run that made the file,
 * the run-relative path, and the content hash. The optional `snapshot` names a point-in-time copy when
 * a host keeps one.
 */
const artifactPinShape = {
    run: z.string().min(1).describe("The analysis run id that produced the artifact."),
    path: z.string().min(1).describe("The run-relative path of the artifact."),
    hash: z.string().regex(HASH_PATTERN).describe("The content hash as `algorithm:hex`, for example `sha256:...`."),
    snapshot: z.string().optional().describe("An optional point-in-time snapshot id."),
};

/**
 * The authored belief about the one value that a reference resolves to. `tolerance` gives the permitted
 * numeric difference.
 *
 * Each kind carries only the assert fields that mean something for it. A shared assert would let an
 * author write a belief that the resolver has no way to match, and silence there defeats the one
 * mechanism that catches a wrong number.
 */
const assertValueShape = {
    value: z.union([z.string(), z.number()]).optional().describe("The value the author expects at resolution time."),
    tolerance: z.number().optional().describe("The permitted absolute difference for a numeric match."),
};

/** The authored belief about the bytes behind a reference. It pins the content hash of the artifact. */
const assertHashShape = {
    hash: z.string().optional().describe("An optional content hash that the resolved artifact must match."),
};

/**
 * The display hints that every reference kind can carry. `unit` and `format` tell a renderer how to show
 * the resolved value.
 */
const displayShape = {
    unit: z.string().optional().describe("The unit of the resolved value, for example `%` or `kb`."),
    format: z.string().optional().describe("A display format hint for the resolved value."),
};

/**
 * The address of exactly one value inside an artifact. `column` names the field. Exactly one of
 * `rowFilter` or `row` selects the row. The refine makes the "exactly one" rule a parse failure, and
 * not a separate check that runs later.
 */
const LocatorSchema = z
    .strictObject({
        column: z.string().describe("The column that holds the value."),
        rowFilter: z
            .strictObject({
                column: z.string(),
                op: z.literal("eq"),
                value: z.union([z.string(), z.number()]),
            })
            .optional()
            .describe("The documented default: the row where a column equals a value."),
        row: z.number().int().nonnegative().optional().describe("A fixed row index. Use it only for an artifact with a stable row order."),
    })
    .refine((v) => (v.rowFilter !== undefined) !== (v.row !== undefined), {
        message: "A locator needs exactly one of `rowFilter` or `row`.",
    });

/**
 * A reference to one scalar value inside an artifact, addressed by a locator. It resolves to a scalar
 * and it is artifact-backed, thus its assert carries both the value fields and the hash field.
 */
export const ArtifactValueReferenceSchema = z.strictObject({
    kind: z.literal("artifact-value"),
    ...artifactPinShape,
    locator: LocatorSchema.describe("The address of the one value that this reference binds."),
    assert: z
        .strictObject({ ...assertValueShape, ...assertHashShape })
        .optional()
        .describe("The authored belief that resolution matches against."),
    ...displayShape,
});

/**
 * A reference to a whole table artifact. It carries no locator, because it binds every row. A table is
 * not one value, thus its assert pins the content hash only.
 */
export const ArtifactTableReferenceSchema = z.strictObject({
    kind: z.literal("artifact-table"),
    ...artifactPinShape,
    columns: z.array(z.string()).optional().describe("An optional column subset to render. Omit to bind every column."),
    assert: z
        .strictObject({ ...assertHashShape })
        .optional()
        .describe("The authored belief about the bytes of the table."),
    ...displayShape,
});

/**
 * A reference to a whole artifact file, for example an image. It carries no locator and no columns,
 * because a file is pinned whole and has no addressable cell inside it. Thus its assert pins the content
 * hash only.
 */
export const ArtifactFileReferenceSchema = z.strictObject({
    kind: z.literal("artifact-file"),
    ...artifactPinShape,
    assert: z
        .strictObject({ ...assertHashShape })
        .optional()
        .describe("The authored belief about the bytes of the file."),
    ...displayShape,
});

/**
 * A reference to an external source, addressed by an external identifier. It resolves to the prefixed
 * key, thus its assert compares against that key and carries no hash.
 */
export const CitationReferenceSchema = z.strictObject({
    kind: z.literal("citation"),
    idKind: z.enum(["doi", "pmid", "arxiv"]).describe("The external identifier space."),
    id: z.string().describe("The external identifier value."),
    raw: z.string().describe("The original citation text."),
    assert: z
        .strictObject({
            value: z
                .union([z.string(), z.number()])
                .optional()
                .describe("The expected citation key in the prefixed `idKind:id` form, for example `pmid:12345`, and not the bare id."),
        })
        .optional()
        .describe("The authored belief about the citation key that resolution gives."),
    ...displayShape,
});

/**
 * The references that a derivation can consume. A derivation is not in this set, thus a derivation over
 * a derivation is unrepresentable at the type level, and not a rule that a later check must enforce.
 */
export const NonDerivationReferenceSchema = z.discriminatedUnion("kind", [
    ArtifactValueReferenceSchema,
    ArtifactTableReferenceSchema,
    ArtifactFileReferenceSchema,
    CitationReferenceSchema,
]);

/**
 * A reference to a value computed from other references. Each of the three operations takes two inputs,
 * thus `inputs` holds exactly two non-derivation references and no other count is representable. The
 * result is computed and not artifact-backed, thus its assert carries the value fields only.
 */
export const DerivationReferenceSchema = z.strictObject({
    kind: z.literal("derivation"),
    op: z.enum(["ratio", "delta", "pctChange"]).describe("The operation over the inputs."),
    inputs: z.array(NonDerivationReferenceSchema).length(2).describe("The two input references. Each operation takes exactly two."),
    assert: z
        .strictObject({ ...assertValueShape })
        .optional()
        .describe("The authored belief that resolution matches against."),
    ...displayShape,
});

/** The full reference union. A block binds to one of these. */
export const ReferenceSchema = z.discriminatedUnion("kind", [
    ArtifactValueReferenceSchema,
    ArtifactTableReferenceSchema,
    ArtifactFileReferenceSchema,
    DerivationReferenceSchema,
    CitationReferenceSchema,
]);

/**
 * The references that resolve to one scalar value. A metric's value slot admits only these, thus no
 * numeric literal can sit in the slot: the type admits a reference only.
 */
export const ScalarReferenceSchema = z.discriminatedUnion("kind", [ArtifactValueReferenceSchema, DerivationReferenceSchema]);

/** The reason that a reference did not resolve. */
export const UnresolvedReasonSchema = z.enum(["artifact-missing", "hash-mismatch", "locator-out-of-range", "ambiguous-match", "assertion-failed"]);

/** A reference that resolution could not bind, with the reason and an optional detail. */
export const UnresolvedReferenceSchema = z.strictObject({
    reference: ReferenceSchema,
    reason: UnresolvedReasonSchema,
    detail: z.string().optional(),
});

export type ArtifactValueReference = z.infer<typeof ArtifactValueReferenceSchema>;
export type ArtifactTableReference = z.infer<typeof ArtifactTableReferenceSchema>;
export type ArtifactFileReference = z.infer<typeof ArtifactFileReferenceSchema>;
export type CitationReference = z.infer<typeof CitationReferenceSchema>;
export type NonDerivationReference = z.infer<typeof NonDerivationReferenceSchema>;
export type DerivationReference = z.infer<typeof DerivationReferenceSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type ScalarReference = z.infer<typeof ScalarReferenceSchema>;
export type UnresolvedReason = z.infer<typeof UnresolvedReasonSchema>;
export type UnresolvedReference = z.infer<typeof UnresolvedReferenceSchema>;

/** The URI scheme and version for a serialized reference. The payload after it is opaque. */
const REFERENCE_URI_PREFIX = "inflexa-ref:v1:";

/**
 * Sort the keys of every object so that serialization is deterministic. An array keeps its order,
 * because the order of a derivation's inputs carries meaning.
 */
function sortKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep);
    }
    if (value !== null && typeof value === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}

/**
 * Serialize a reference to a canonical URI.
 *
 * The payload is an opaque base64url of the canonical JSON, and not a structured URI with a field for
 * each property. The reference object is the source of truth. A structured URI re-parses field by
 * field, and it drifts from the object as the shape grows. An opaque payload cannot drift, because it
 * round-trips the whole object.
 */
export function serializeReference(reference: Reference): string {
    const json = JSON.stringify(sortKeysDeep(reference));
    const payload = Buffer.from(json, "utf8").toString("base64url");
    return REFERENCE_URI_PREFIX + payload;
}

/**
 * Parse a reference URI. A malformed prefix, malformed JSON, or a value that the schema rejects gives
 * `null`. This function never throws, thus a caller treats absence as a normal condition.
 */
export function parseReference(uri: string): Reference | null {
    if (!uri.startsWith(REFERENCE_URI_PREFIX)) {
        return null;
    }
    const payload = uri.slice(REFERENCE_URI_PREFIX.length);
    const json = Buffer.from(payload, "base64url").toString("utf8");
    let candidate: unknown;
    try {
        candidate = JSON.parse(json);
    } catch {
        // `JSON.parse` throws on malformed input. The domain contract returns `null` instead of a throw.
        return null;
    }
    const result = ReferenceSchema.safeParse(candidate);
    return result.success ? result.data : null;
}
