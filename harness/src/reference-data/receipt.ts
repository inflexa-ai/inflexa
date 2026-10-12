import { createHash } from "node:crypto";

import { z } from "zod";

import { ReferenceArtifactPathSchema, ReferenceDatasetSchema, ReferenceSha256Schema } from "./catalog.js";

/** Schema version for installation receipts shared by all embedders. */
export const REFERENCE_INSTALL_RECEIPT_VERSION = 2 as const;

/**
 * What was actually written to disk for one artifact. The size and digest are
 * *observed at install* — the catalog carries neither, so this receipt is the
 * sole record of the bytes the upstream served, and what `verify` later checks
 * the local files against.
 */
const ReferenceReceiptArtifactSchema = z.object({
    path: ReferenceArtifactPathSchema,
    bytes: z.number().int().nonnegative(),
    sha256: ReferenceSha256Schema,
});

/** The fields of a receipt that identify the installed content. */
export interface ReferenceReceiptContent {
    readonly datasetId: string;
    readonly datasetVersion: string;
    readonly artifacts: readonly ReferenceReceiptArtifact[];
}

/**
 * The identity of the installed bytes, independent of the install time. Consumers outside the
 * harness recompute it, so the input bytes are a contract: the SHA-256 of the compact JSON array
 * `[datasetId, datasetVersion, [[path, bytes, sha256], ...]]`, artifacts in code-unit order of path.
 */
export function referenceReceiptContentDigest(content: ReferenceReceiptContent): string {
    const artifacts = [...content.artifacts]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((artifact) => [artifact.path, artifact.bytes, artifact.sha256]);
    return createHash("sha256")
        .update(JSON.stringify([content.datasetId, content.datasetVersion, artifacts]), "utf8")
        .digest("hex");
}

/** Optional metadata describing one activated reference dataset version. */
export const ReferenceInstallReceiptSchema = z
    .object({
        version: z.literal(REFERENCE_INSTALL_RECEIPT_VERSION),
        datasetId: ReferenceDatasetSchema.shape.id,
        datasetVersion: ReferenceDatasetSchema.shape.version,
        activatedAt: z.iso.datetime({ offset: true }),
        contentDigest: ReferenceSha256Schema,
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
        if (receipt.contentDigest !== referenceReceiptContentDigest(receipt)) {
            ctx.addIssue({ code: "custom", message: "Receipt content digest does not match its dataset and artifacts", path: ["contentDigest"] });
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
