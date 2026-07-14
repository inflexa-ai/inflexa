import { z } from "zod";

import { ReferenceArtifactPathSchema, ReferenceDatasetSchema, ReferenceSha256Schema } from "./catalog.js";

/** Schema version for installation receipts shared by all embedders. */
export const REFERENCE_INSTALL_RECEIPT_VERSION = 1 as const;

/**
 * What was actually written to disk for one artifact. The size and digest are
 * *observed at install*, never copied from the catalog — for a `pinned`
 * artifact they equal the catalog's (the install would have failed otherwise),
 * and for an `unpinned` one they are the only record of what the mutable
 * upstream served, which is what `verify` later checks the files against.
 */
const ReferenceReceiptArtifactSchema = z.object({
    path: ReferenceArtifactPathSchema,
    bytes: z.number().int().nonnegative(),
    sha256: ReferenceSha256Schema,
    integrity: z.enum(["pinned", "unpinned"]),
});

/** Optional metadata describing one activated reference dataset version. */
export const ReferenceInstallReceiptSchema = z
    .object({
        version: z.literal(REFERENCE_INSTALL_RECEIPT_VERSION),
        datasetId: ReferenceDatasetSchema.shape.id,
        datasetVersion: ReferenceDatasetSchema.shape.version,
        activatedAt: z.iso.datetime({ offset: true }),
        artifacts: z.array(ReferenceReceiptArtifactSchema).min(1),
    })
    .superRefine((receipt, ctx) => {
        const paths = new Set<string>();
        for (const [index, artifact] of receipt.artifacts.entries()) {
            if (paths.has(artifact.path)) {
                ctx.addIssue({ code: "custom", message: `Duplicate receipt artifact path: ${artifact.path}`, path: ["artifacts", index, "path"] });
            }
            paths.add(artifact.path);
        }
    });

export type ReferenceInstallReceipt = z.infer<typeof ReferenceInstallReceiptSchema>;

/** One artifact as recorded by a completed installation. */
export type ReferenceReceiptArtifact = z.infer<typeof ReferenceReceiptArtifactSchema>;

/** Parse optional/untrusted receipt metadata; invalid receipts are ignored. */
export function parseReferenceInstallReceipt(input: unknown): ReferenceInstallReceipt | undefined {
    const result = ReferenceInstallReceiptSchema.safeParse(input);
    return result.success ? result.data : undefined;
}
