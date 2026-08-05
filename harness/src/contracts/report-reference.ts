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

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

/**
 * The shape of a content hash, as lowercase `algorithm:hex`, for example `sha256:9f86d0...`. The
 * resolver compares this text against a fresh read with exact string equality, and the producer emits
 * lowercase only. Thus the pattern rejects an uppercase hex digit, which would pass a case-insensitive
 * match here but never resolve against the lowercase producer.
 */
const HASH_PATTERN = /^[a-z0-9]+:[0-9a-f]+$/;

/**
 * The pin that ties an artifact reference to one immutable file. It names the analysis-relative path and
 * the content hash, and it can name the run that made the file. The optional `snapshot` names a
 * point-in-time copy when a host keeps one.
 *
 * `path` is the key of `cortex_artifacts`, whose primary key is `(analysis_id, path)`. Thus the path
 * spans the whole analysis and it already holds the run segment for a run output, for example
 * `runs/{runId}/{stepId}/output/de.csv`.
 */
const artifactPinShape = {
    run: z.string().min(1).optional().describe("The analysis run id that produced the artifact. It is absent for a staged input file, which no run produced."),
    path: z.string().min(1).describe("The analysis-relative path of the artifact, the key of `cortex_artifacts.path`."),
    hash: z.string().regex(HASH_PATTERN).describe("The content hash as `algorithm:hex`, for example `sha256:...`."),
    snapshot: z.string().optional().describe("An optional point-in-time snapshot id."),
};

/**
 * The authored belief about the one value that a reference resolves to. `tolerance` gives the permitted
 * numeric difference.
 *
 * `value` is mandatory, thus an assert that asserts nothing is unrepresentable. A `tolerance` alone has
 * nothing to compare against, and an empty assert reads as a belief that the resolver silently ignores.
 *
 * There is no hash field here. An artifact reference already pins `hash`, and resolution compares that
 * pin against the fresh read and gives `hash-mismatch`. A second hash in the assert would compare the
 * reference against itself, thus it adds no evidence.
 */
const AssertValueSchema = z.strictObject({
    value: z.union([z.string(), z.number()]).describe("The value the author expects at resolution time."),
    tolerance: z.number().optional().describe("The permitted absolute difference for a numeric match."),
});

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
 * A reference to one scalar value inside an artifact, addressed by a locator. It resolves to a scalar,
 * thus it carries the value assert.
 */
export const ArtifactValueReferenceSchema = z.strictObject({
    kind: z.literal("artifact-value"),
    ...artifactPinShape,
    locator: LocatorSchema.describe("The address of the one value that this reference binds."),
    assert: AssertValueSchema.optional().describe("The authored belief that resolution matches against."),
    ...displayShape,
});

/**
 * A reference to a whole table artifact. It carries no locator, because it binds every row.
 *
 * It carries no assert. A table is not one value, thus the only belief that an author can hold about it
 * is its bytes, and the pinned `hash` already carries that belief.
 */
export const ArtifactTableReferenceSchema = z.strictObject({
    kind: z.literal("artifact-table"),
    ...artifactPinShape,
    columns: z.array(z.string()).optional().describe("An optional column subset to render. Omit to bind every column."),
    ...displayShape,
});

/**
 * A reference to a whole artifact file, for example an image. It carries no locator and no columns,
 * because a file is pinned whole and has no addressable cell inside it. It carries no assert, for the
 * same reason as a table reference.
 */
export const ArtifactFileReferenceSchema = z.strictObject({
    kind: z.literal("artifact-file"),
    ...artifactPinShape,
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
            // The value is a string and not the wider scalar union of a value assert. Resolution gives the
            // key as text, thus a number here can never match and the schema would admit a belief that
            // always fails.
            value: z.string().describe("The expected citation key in the prefixed `idKind:id` form, for example `pmid:12345`, and not the bare id."),
        })
        .optional()
        .describe("The authored belief about the citation key that resolution gives."),
    ...displayShape,
});

/**
 * The one reference kind that a derivation can consume.
 *
 * The arithmetic needs a scalar, and `artifact-value` is the only reference that resolves to one without
 * itself being a derivation. A table, a file, and a citation resolve to something else, thus each is
 * unrepresentable here rather than a parse that succeeds and then always fails at resolution. A
 * derivation is out of the set too, thus a derivation over a derivation stays unrepresentable.
 */
export const DerivationInputReferenceSchema = ArtifactValueReferenceSchema;

/**
 * A reference to a value computed from other references. Each of the three operations takes two inputs,
 * thus `inputs` holds exactly two scalar-resolving references and no other count is representable. The
 * result is computed and not artifact-backed, thus its assert carries the value fields only.
 */
export const DerivationReferenceSchema = z.strictObject({
    kind: z.literal("derivation"),
    op: z
        .enum(["ratio", "delta", "pctChange"])
        .describe(
            "The operation over the two inputs `a` and `b`: `ratio` gives `a / b`, `delta` gives `a - b`, and `pctChange` gives `(a - b) / b` as a fraction and not as a percent. A change of one half resolves to 0.5, thus an `assert.value` states the fraction and a `unit` of `%` is a display hint only.",
        ),
    inputs: z
        .array(DerivationInputReferenceSchema)
        .length(2)
        .describe("The two input references. Each operation takes exactly two, and each one must resolve to a scalar."),
    assert: AssertValueSchema.optional().describe("The authored belief that resolution matches against."),
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
export type DerivationInputReference = z.infer<typeof DerivationInputReferenceSchema>;
export type DerivationReference = z.infer<typeof DerivationReferenceSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type ScalarReference = z.infer<typeof ScalarReferenceSchema>;
export type UnresolvedReason = z.infer<typeof UnresolvedReasonSchema>;
export type UnresolvedReference = z.infer<typeof UnresolvedReferenceSchema>;

/** The URI scheme and version for a serialized reference. The payload after it is opaque. */
const REFERENCE_URI_PREFIX = "inflexa-ref:v1:";

/**
 * The alphabet of a non-empty base64url payload. The check is explicit because `Buffer.from(text,
 * "base64url")` never throws: it drops each character outside the alphabet and decodes what is left.
 * Thus a corrupt payload would otherwise decode to mojibake and report as malformed JSON, which names
 * the wrong failure.
 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

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
 * The reason that a reference URI did not parse. Each of the four modes is distinct: a wrong prefix, a
 * payload that is empty or holds a character outside the base64url alphabet, JSON that does not parse,
 * and a value that the schema rejects. A caller reads the `kind` to tell them apart. `detail` carries no
 * secret, thus a schema mismatch gives the kind alone.
 */
export type ParseReferenceError = {
    kind: "bad-prefix" | "invalid-payload" | "invalid-json" | "schema-mismatch";
    detail?: string;
};

/**
 * Parse a reference URI. Each failure mode gives its own `Err` `kind`, thus a caller tells a wrong
 * prefix from malformed bytes, malformed JSON, and a schema mismatch. This function never throws, thus a
 * caller treats a failed parse as a normal condition.
 */
export function parseReference(uri: string): Result<Reference, ParseReferenceError> {
    if (!uri.startsWith(REFERENCE_URI_PREFIX)) {
        return err({ kind: "bad-prefix" });
    }
    const payload = uri.slice(REFERENCE_URI_PREFIX.length);
    if (!BASE64URL_PATTERN.test(payload)) {
        return err({ kind: "invalid-payload" });
    }
    const json = Buffer.from(payload, "base64url").toString("utf8");
    let candidate: unknown;
    try {
        candidate = JSON.parse(json);
    } catch {
        // `JSON.parse` throws on malformed input. The boundary turns the throw into an `Err`.
        return err({ kind: "invalid-json" });
    }
    const result = ReferenceSchema.safeParse(candidate);
    return result.success ? ok(result.data) : err({ kind: "schema-mismatch" });
}
