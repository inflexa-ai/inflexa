import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { VerifyResult } from "../../types/prov.ts";
import type { IdOrName } from "../../lib/types.ts";
import { getAnalysisIntegrity } from "../../db/primary_query.ts";
import { findAnalysisForProv } from "./document.ts";
import { computeChainHash, computePayloadDigest, verifyHexDigest, loadPublicKey, loadOrGenerateKeypair, exportPublicKeyJwk, signHexDigest } from "./signing.ts";
import { dieOn, fail } from "../../lib/cli.ts";

/**
 * DB-path verification: recompute the rolling chain hash from `prevChainHash` and the stored
 * PROV-JSON, then check the Ed25519 signature over it. Used by `prov verify` (the internal
 * command that reads integrity columns from the database).
 *
 * `prevChainHash` is the chain hash from the PREVIOUS flush — needed to recompute the current one
 * (`H_n = SHA-256(H_{n-1} || json_n)`). `null` on the first flush, where the seed is SHA-256("").
 */
export async function verifyProvenance(
    provJson: string | null,
    prevChainHash: string | null,
    storedChainHash: string | null,
    storedSignature: string | null,
    publicKey: CryptoKey | null,
): Promise<VerifyResult> {
    if (provJson === null) return { status: "empty" };
    if (storedChainHash === null || storedSignature === null) return { status: "unsigned" };
    if (publicKey === null) return { status: "no-key" };

    const recomputed = await computeChainHash(prevChainHash, provJson);
    if (recomputed !== storedChainHash) {
        return { status: "tampered", detail: "chain hash mismatch: the PROV-JSON has been modified since it was signed" };
    }

    const ok = await verifyHexDigest(publicKey, storedSignature, storedChainHash);
    if (!ok) {
        return { status: "tampered", detail: "signature verification failed: the chain hash or signature has been modified" };
    }

    return { status: "valid" };
}

/**
 * File-path verification: check a simple `SHA-256(provJson)` content digest and its Ed25519
 * signature. Used by `prov verify-file` and the TUI "Verify provenance (export)" command —
 * the sidecar is self-contained, no chain mechanics needed.
 */
export async function verifyPayload(provJson: string, storedDigest: string, storedSignature: string, publicKey: CryptoKey): Promise<VerifyResult> {
    const recomputed = await computePayloadDigest(provJson);
    if (recomputed !== storedDigest) {
        return { status: "tampered", detail: "payload digest mismatch: the provenance file has been modified since it was signed" };
    }

    const ok = await verifyHexDigest(publicKey, storedSignature, storedDigest);
    if (!ok) {
        return { status: "tampered", detail: "signature verification failed: the digest or signature has been modified" };
    }

    return { status: "valid" };
}

/** Format a {@link VerifyResult} as a human-readable line for CLI output or TUI notice. */
export function formatVerifyResult(result: VerifyResult): string {
    switch (result.status) {
        case "valid":
            return "Provenance integrity verified: chain hash and signature are valid.";
        case "unsigned":
            return "Provenance is unsigned (recorded before integrity was enabled, or without a signing key).";
        case "tampered":
            return `Provenance integrity FAILED: ${result.detail}`;
        case "no-key":
            return "Cannot verify: a signature exists but the signing key file is missing.";
        case "empty":
            return "No provenance has been recorded for this analysis.";
        case "invalid-sidecar":
            return `Invalid sidecar: ${result.detail}`;
        case "invalid-key":
            return "The public key in the sidecar is invalid or unsupported.";
    }
}

/**
 * Verify an analysis's stored provenance from its DB integrity columns: load the integrity data,
 * load the public key, and run {@link verifyProvenance}. Returns `null` only when the analysis
 * row does not exist. Shared by the CLI `prov verify` action and the TUI palette command.
 */
export async function verifyAnalysisIntegrity(analysisId: string): Promise<VerifyResult | null> {
    const integrity = getAnalysisIntegrity(analysisId).match(
        (i) => i,
        () => null,
    );
    if (!integrity) return null;

    const publicKey = await loadPublicKey();
    return verifyProvenance(integrity.provenance, integrity.prevChainHash, integrity.chainHash, integrity.signature, publicKey);
}

/**
 * CLI action for `inflexa prov verify <analysis>`: resolve the analysis, load integrity data
 * from the DB, load the public key, run verification, and print the result.
 */
export async function runVerifyProvenance(ref: string): Promise<void> {
    const analysis = findAnalysisForProv(ref as IdOrName).match((a) => a, dieOn("Failed to resolve analysis"));
    if (!analysis) fail(`No analysis found matching "${ref}".`);

    const result = await verifyAnalysisIntegrity(analysis.id);
    if (!result) fail(`No analysis row for "${ref}".`);

    console.log(formatVerifyResult(result));
    if (result.status === "tampered") process.exitCode = 1;
}

/**
 * The self-describing export sidecar. A recipient verifies integrity with just the provenance
 * file and this sidecar — no database, no chain history, no internal state needed.
 *
 * Zod-validated on read so a corrupt or hand-edited `.sig.json` surfaces a clear "invalid
 * sidecar" error instead of a downstream type confusion.
 */
export const sidecarSchema = z.object({
    /** MIME type of the payload file. */
    payloadType: z.literal("application/json; profile=prov-json"),
    /** Hash algorithm used to compute {@link payloadDigest}. */
    payloadDigestAlgorithm: z.literal("SHA-256"),
    /** `SHA-256(file bytes)` — the recipient recomputes this from the file and compares. */
    payloadDigest: z.string(),
    /** How the digest input was derived — "verbatim" means exact file bytes, no canonicalization. */
    payloadDigestMethod: z.literal("verbatim"),
    /** Signature algorithm. */
    signatureAlgorithm: z.literal("Ed25519"),
    /** Ed25519 signature over the {@link payloadDigest} — proves it was produced by the key holder. */
    signature: z.string(),
    /** The signer's public key as JWK — lets the recipient verify without the keypair file. */
    publicKey: z.record(z.string(), z.unknown()),
});

/** The validated sidecar shape — inferred from the schema so the type never drifts. */
export type Sidecar = z.infer<typeof sidecarSchema>;

/**
 * Build a sidecar for an exported provenance file. Computes `SHA-256(provJson)` as the content
 * digest and signs it with the Ed25519 private key. Returns `null` when no signing key is
 * available. The sidecar is self-contained — a recipient verifies with just the file and the
 * sidecar, no chain history or database access needed.
 */
export async function buildSidecar(provJson: string): Promise<Sidecar | null> {
    const kp = await loadOrGenerateKeypair();
    if (!kp) return null;

    const publicKeyJwk = await exportPublicKeyJwk();
    if (!publicKeyJwk) return null;

    const digest = await computePayloadDigest(provJson);
    const signature = await signHexDigest(kp.privateKey, digest);

    return {
        payloadType: "application/json; profile=prov-json",
        payloadDigestAlgorithm: "SHA-256",
        payloadDigest: digest,
        payloadDigestMethod: "verbatim",
        signatureAlgorithm: "Ed25519",
        signature,
        publicKey: publicKeyJwk as Record<string, unknown>,
    };
}

/** Parse a `.sig.json` sidecar file, returning `null` on missing/corrupt/malformed. */
export function readSidecar(sigPath: string): Sidecar | null {
    try {
        return JSON.parseWith(readFileSync(sigPath, "utf-8"), sidecarSchema);
    } catch {
        return null;
    }
}

/**
 * Verify an exported provenance file against its `.sig.json` sidecar. Shared by the CLI
 * `prov verify-file` action and the TUI "Verify provenance (export)" command — both need the same
 * read-sidecar → import-key → verify-payload pipeline. Returns `null` when no sidecar exists.
 * Corrupt sidecars and invalid keys are returned as `VerifyResult` statuses, not thrown — callers
 * handle them the same way as any other verification outcome.
 *
 * // TODO(robustness): the public key is trusted solely because it travels in the sidecar — an
 * // attacker who replaces both the provenance file and the sidecar (with their own key) passes
 * // verification. For teammate-to-teammate sharing over trusted channels this is fine; for stronger
 * // trust, support key pinning: the verifier registers the signer's public key once, then future
 * // verify calls check the sidecar's key against the pinned one.
 */
export async function verifyExportFile(provPath: string): Promise<VerifyResult | null> {
    const sigPath = `${provPath}.sig.json`;
    if (!existsSync(sigPath)) return null;

    const sidecar = readSidecar(sigPath);
    if (!sidecar) return { status: "invalid-sidecar", detail: `sidecar at ${sigPath} is invalid or missing required fields` };

    let publicKey: CryptoKey;
    try {
        publicKey = await crypto.subtle.importKey("jwk", sidecar.publicKey, "Ed25519", true, ["verify"]);
    } catch {
        return { status: "invalid-key" };
    }

    const provJson = readFileSync(provPath, "utf-8");
    return verifyPayload(provJson, sidecar.payloadDigest, sidecar.signature, publicKey);
}

/**
 * CLI action for `inflexa prov verify-file <path>`: verify an exported provenance file against
 * its `.sig.json` sidecar. No database or analysis row needed — a colleague who receives the
 * exported files can run this to confirm integrity.
 */
export async function runVerifyFile(path: string): Promise<void> {
    if (!existsSync(path)) fail(`File not found: ${path}`);

    const result = await verifyExportFile(path);
    if (!result) {
        console.log("No sidecar found: the provenance file cannot be verified without a .sig.json sidecar.");
        return;
    }
    console.log(formatVerifyResult(result));
    if (result.status === "tampered" || result.status === "invalid-sidecar" || result.status === "invalid-key") process.exitCode = 1;
}
