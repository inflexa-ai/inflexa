import { z } from "zod";

import { ReferenceArtifactSchema, ReferenceDatasetSchema } from "./catalog.js";

/** Schema version for installation receipts shared by all embedders. */
export const REFERENCE_INSTALL_RECEIPT_VERSION = 1 as const;

/** Optional metadata describing one activated reference dataset version. */
export const ReferenceInstallReceiptSchema = z
    .object({
        version: z.literal(REFERENCE_INSTALL_RECEIPT_VERSION),
        datasetId: ReferenceDatasetSchema.shape.id,
        datasetVersion: ReferenceDatasetSchema.shape.version,
        activatedAt: z.iso.datetime({ offset: true }),
        artifacts: z.array(ReferenceArtifactSchema.pick({ path: true, bytes: true, sha256: true })).min(1),
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

/** Parse optional/untrusted receipt metadata; invalid receipts are ignored. */
export function parseReferenceInstallReceipt(input: unknown): ReferenceInstallReceipt | undefined {
    const result = ReferenceInstallReceiptSchema.safeParse(input);
    return result.success ? result.data : undefined;
}
