import { z } from "zod";
import { err, type Result } from "neverthrow";
import type { VerifyResult } from "./types.js";
import { computeChainHash, computePayloadDigest, verifyHexDigest, type ProvPublicKeyJwk, type ProvSigner, type ProvSigningError } from "./signing.js";

/**
 * Provenance verification, parameterized on stored values — no database, no filesystem. Hosts wrap
 * these with their own storage reads (the OSS host's integrity columns and `.sig.json` files, a
 * managed host's document rows).
 */

/**
 * Chained verification: recompute the rolling chain hash from `prevChainHash` and the stored
 * PROV-JSON, then check the Ed25519 signature over it.
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

    const hashResult = await computeChainHash(prevChainHash, provJson);
    if (hashResult.isErr())
        return {
            status: "verify-error",
            detail: `chain hash computation failed: ${String("cause" in hashResult.error ? hashResult.error.cause : hashResult.error.type)}`,
        };
    if (hashResult.value !== storedChainHash) {
        return { status: "tampered", detail: "chain hash mismatch: the PROV-JSON has been modified since it was signed" };
    }

    const sigResult = await verifyHexDigest(publicKey, storedSignature, storedChainHash);
    if (sigResult.isErr())
        return {
            status: "verify-error",
            detail: `signature verification failed: ${String("cause" in sigResult.error ? sigResult.error.cause : sigResult.error.type)}`,
        };
    if (!sigResult.value) {
        return { status: "tampered", detail: "signature verification failed: the chain hash or signature has been modified" };
    }

    return { status: "valid" };
}

/**
 * Self-contained verification: check a simple `SHA-256(provJson)` content digest and its Ed25519
 * signature — the sidecar path, no chain mechanics needed.
 */
export async function verifyPayload(provJson: string, storedDigest: string, storedSignature: string, publicKey: CryptoKey): Promise<VerifyResult> {
    const digestResult = await computePayloadDigest(provJson);
    if (digestResult.isErr())
        return {
            status: "verify-error",
            detail: `payload digest computation failed: ${String("cause" in digestResult.error ? digestResult.error.cause : digestResult.error.type)}`,
        };
    if (digestResult.value !== storedDigest) {
        return { status: "tampered", detail: "payload digest mismatch: the provenance file has been modified since it was signed" };
    }

    const sigResult = await verifyHexDigest(publicKey, storedSignature, storedDigest);
    if (sigResult.isErr())
        return {
            status: "verify-error",
            detail: `signature verification failed: ${String("cause" in sigResult.error ? sigResult.error.cause : sigResult.error.type)}`,
        };
    if (!sigResult.value) {
        return { status: "tampered", detail: "signature verification failed: the digest or signature has been modified" };
    }

    return { status: "valid" };
}

/** Format a {@link VerifyResult} as a human-readable line. */
export function formatVerifyResult(result: VerifyResult): string {
    switch (result.status) {
        case "valid":
            return "Provenance integrity verified: chain hash and signature are valid.";
        case "unsigned":
            return "Provenance is unsigned (recorded before integrity was enabled, or without a signing key).";
        case "tampered":
            return `Provenance integrity FAILED: ${result.detail}`;
        case "no-key":
            return "Cannot verify: a signature exists but the signing key is missing.";
        case "empty":
            return "No provenance has been recorded for this analysis.";
        case "invalid-sidecar":
            return `Invalid sidecar: ${result.detail}`;
        case "invalid-key":
            return "The public key in the sidecar is invalid or unsupported.";
        case "verify-error":
            return `Verification could not complete (internal error): ${result.detail}`;
    }
}

/**
 * The self-describing export sidecar. A recipient verifies integrity with just the provenance
 * payload and this sidecar — no database, no chain history, no internal state needed.
 *
 * Zod-validated on read so a corrupt or hand-edited sidecar surfaces a clear "invalid sidecar"
 * error instead of a downstream type confusion.
 */
export const sidecarSchema = z.object({
    /** MIME type of the payload. */
    payloadType: z.literal("application/json; profile=prov-json"),
    /** Hash algorithm used to compute {@link payloadDigest}. */
    payloadDigestAlgorithm: z.literal("SHA-256"),
    /** `SHA-256(payload bytes)` — the recipient recomputes this and compares. */
    payloadDigest: z.string(),
    /** How the digest input was derived — "verbatim" means exact payload bytes, no canonicalization. */
    payloadDigestMethod: z.literal("verbatim"),
    /** Signature algorithm. */
    signatureAlgorithm: z.literal("Ed25519"),
    /** Ed25519 signature over the {@link payloadDigest} — proves it was produced by the key holder. */
    signature: z.string(),
    /** The signer's public key as JWK — lets the recipient verify without any key file. */
    publicKey: z.record(z.string(), z.unknown()),
});

/** The validated sidecar shape — inferred from the schema so the type never drifts. */
export type Sidecar = z.infer<typeof sidecarSchema>;

/**
 * Build a sidecar for an exported provenance payload. Computes `SHA-256(provJson)` as the content
 * digest and signs it through the injected {@link ProvSigner}. Returns `err(ProvSigningError)`
 * when signing is unavailable — provenance is never exported unsigned. The sidecar is
 * self-contained: a recipient verifies with just the payload and the sidecar.
 */
export async function buildSidecar(signer: ProvSigner, provJson: string): Promise<Result<Sidecar, ProvSigningError>> {
    const pubKeyResult = await signer.exportPublicKeyJwk();
    if (pubKeyResult.isErr()) return err(pubKeyResult.error);
    const publicKeyJwk: ProvPublicKeyJwk | null = pubKeyResult.value;
    if (!publicKeyJwk) return err({ type: "public_key_export_failed" });

    return computePayloadDigest(provJson).andThen((digest) =>
        signer.sign(digest).map((signature): Sidecar => ({
            payloadType: "application/json; profile=prov-json" as const,
            payloadDigestAlgorithm: "SHA-256" as const,
            payloadDigest: digest,
            payloadDigestMethod: "verbatim" as const,
            signatureAlgorithm: "Ed25519" as const,
            signature,
            publicKey: publicKeyJwk,
        })),
    );
}

/**
 * Verify a provenance payload against its parsed sidecar: import the sidecar's public key and run
 * {@link verifyPayload}. Corrupt keys are returned as `VerifyResult` statuses, not thrown.
 *
 * The public key is trusted solely because it travels in the sidecar — an attacker who replaces
 * both the payload and the sidecar (with their own key) passes verification. For sharing over
 * trusted channels this is fine; for stronger trust a host pins the signer's public key and
 * checks the sidecar's key against the pinned one before calling this.
 */
export async function verifySidecar(provJson: string, sidecar: Sidecar): Promise<VerifyResult> {
    let publicKey: CryptoKey;
    try {
        publicKey = await crypto.subtle.importKey("jwk", sidecar.publicKey, "Ed25519", true, ["verify"]);
    } catch {
        return { status: "invalid-key" };
    }
    return verifyPayload(provJson, sidecar.payloadDigest, sidecar.signature, publicKey);
}
