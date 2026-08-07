import { randomUUIDv7 } from "bun";
import { ok, type Result } from "neverthrow";
import type { BuiltinProvFormat } from "@inflexa-ai/tsprov";
import { createProvDocumentModel, PROV_UNIFY_OPTIONS, type ProvSubject } from "@inflexa-ai/prov-kernel";
import type { Analysis } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { getAnalysisProvenance } from "../../db/primary_query.ts";

// The cli's construction of the kernel document model, plus the cli-specific serialization that
// reads the stored column. The dialect itself — QName derivation, statement builders, unify
// policy — is `@inflexa-ai/prov-kernel`'s; nothing here appends a core statement.

/**
 * The cli's historical QName digest: `Bun.hash(s).toString(36)`. Every file/command/agent QName in
 * an existing local document embeds this derivation, and documents are immutable and signed —
 * switching to the kernel's default digest would fork the identifier space, so re-emission after
 * an upgrade would mint new QNames for the same files and `unified()` would keep both. Pinned by
 * the kernel-compat fixture test; never change this expression.
 */
export function cliProvDigest(s: string): string {
    return Bun.hash(s).toString(36);
}

/**
 * The one document model every cli producer and reader shares. `digest` is the continuity-pinned
 * historical derivation above; `mintActionId` keeps lifecycle action ids on the cli's single
 * time-sortable id scheme (`randomUUIDv7`).
 */
export const provModel = createProvDocumentModel({ digest: cliProvDigest, mintActionId: randomUUIDv7 });

/** The kernel subject for an analysis — the identity fields its PROV subject entity carries. */
export function provSubject(analysis: Analysis): ProvSubject {
    return { analysisId: analysis.id, name: analysis.name, slug: analysis.slug };
}

/**
 * Serialize an analysis's provenance for export. For JSON format, returns the **exact stored bytes**
 * from the DB column — the same bytes the chain hash was computed over, so the export is verifiable
 * against the sidecar. For other formats (PROV-N), deserializes and re-serializes into the target
 * format; this is a lossy conversion that cannot be verified against the chain hash (which is
 * always over the JSON form).
 */
export function serializeProvenance(analysis: Analysis, format: BuiltinProvFormat): Result<string, DbError> {
    return getAnalysisProvenance(analysis.id).andThen((json): Result<string, DbError> => {
        if (format === "json" && json !== null) return ok(json);
        return (
            provModel
                .loadDocument(provSubject(analysis), json)
                // Same last-write-wins merge as the flush ({@link PROV_UNIFY_OPTIONS}), so the export and
                // the signed column resolve any re-emitted record to the same survivor. A conflict never
                // throws, so a writer defect can never make an analysis permanently un-exportable.
                .map((doc) => doc.unified(PROV_UNIFY_OPTIONS).serialize(format))
                .mapErr((e): DbError => ({ type: "query_failed", op: "serializeProvenance:deserialize", cause: e.cause }))
        );
    });
}
