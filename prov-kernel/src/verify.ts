import { z } from "zod";
import { err, type Result } from "neverthrow";
import type { VerifyResult } from "./types.js";
import {
    computeChainHash,
    computePayloadDigest,
    importPublicKeyJwk,
    verifyHexDigest,
    type ProvPublicKeyJwk,
    type ProvSigner,
    type ProvSigningError,
} from "./signing.js";

/**
 * Provenance verification, parameterized on stored values — no database, no filesystem. Hosts wrap
 * these with their own storage reads (a CLI host's integrity columns and `.sig.json` files, a
 * managed host's document rows).
 */

/**
 * Chained verification: recompute the rolling chain hash from `prevChainHash` and the stored
 * PROV-JSON, then check the Ed25519 signature over it.
 *
 * `prevChainHash` is the chain hash from the PREVIOUS flush — needed to recompute the current one
 * (`H_n = SHA-256(H_{n-1} || json_n)`). `null` on the first flush, where the seed is SHA-256("").
 */
/**
 * A signing failure's human-readable cause for a detail line: the error's message when the cause
 * carries one, its own text when it is a primitive, and the variant's name otherwise — an object
 * cause would stringify as `[object Object]` and say nothing.
 */
function causeDetail(error: ProvSigningError): string {
    if (!("cause" in error)) return error.type;
    const { cause } = error;
    if (cause instanceof Error) return cause.message;
    if (typeof cause === "string" || typeof cause === "number" || typeof cause === "boolean") return String(cause);
    return error.type;
}

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
            detail: `chain hash computation failed: ${causeDetail(hashResult.error)}`,
        };
    if (hashResult.value !== storedChainHash) {
        return { status: "tampered", detail: "chain hash mismatch: the PROV-JSON has been modified since it was signed" };
    }

    const sigResult = await verifyHexDigest(publicKey, storedSignature, storedChainHash);
    if (sigResult.isErr())
        return {
            status: "verify-error",
            detail: `signature verification failed: ${causeDetail(sigResult.error)}`,
        };
    if (!sigResult.value) {
        return { status: "tampered", detail: "signature verification failed: the chain hash or signature has been modified" };
    }

    return { status: "valid" };
}

/**
 * Self-contained verification: check a simple `SHA-256(provJson)` content digest and its Ed25519
 * signature — the attestation path, no chain mechanics needed.
 */
export async function verifyPayload(provJson: string, storedDigest: string, storedSignature: string, publicKey: CryptoKey): Promise<VerifyResult> {
    const digestResult = await computePayloadDigest(provJson);
    if (digestResult.isErr())
        return {
            status: "verify-error",
            detail: `payload digest computation failed: ${causeDetail(digestResult.error)}`,
        };
    if (digestResult.value !== storedDigest) {
        return { status: "tampered", detail: "payload digest mismatch: the provenance file has been modified since it was signed" };
    }

    const sigResult = await verifyHexDigest(publicKey, storedSignature, storedDigest);
    if (sigResult.isErr())
        return {
            status: "verify-error",
            detail: `signature verification failed: ${causeDetail(sigResult.error)}`,
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
        case "invalid-attestation":
            return `Invalid attestation: ${result.detail}`;
        case "invalid-key":
            return "The public key in the attestation is invalid or unsupported.";
        case "verify-error":
            return `Verification could not complete (internal error): ${result.detail}`;
    }
}

/**
 * The self-describing export attestation. A recipient verifies integrity with just the provenance
 * payload and this attestation — no database, no chain history, no internal state needed.
 *
 * Zod-validated on read so a corrupt or hand-edited attestation surfaces a clear "invalid
 * attestation" error instead of a downstream type confusion.
 */
/**
 * The Ed25519 OKP JWK an attestation's `publicKey` carries. JWK defines further optional members,
 * thus the shape stays loose beyond the three that identify the key.
 */
const publicKeyJwkSchema = z.looseObject({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.base64url(),
});

export const attestationSchema = z.object({
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
    publicKey: publicKeyJwkSchema,
    /** Optional signer id — when several writers sign one document's exports, `kid` says which key signed this one. */
    kid: z.string().optional(),
});

/** The validated attestation shape — inferred from the schema so the type never drifts. */
export type ProvAttestation = z.infer<typeof attestationSchema>;

/**
 * Build an attestation for an exported provenance payload. Computes `SHA-256(provJson)` as the
 * content digest and signs it through the injected {@link ProvSigner}. Returns
 * `err(ProvSigningError)` when signing is unavailable — provenance is never exported unsigned. The
 * attestation is self-contained: a recipient verifies with just the payload and the attestation.
 */
export async function buildAttestation(signer: ProvSigner, provJson: string, opts?: { kid?: string }): Promise<Result<ProvAttestation, ProvSigningError>> {
    const pubKeyResult = await signer.exportPublicKeyJwk();
    if (pubKeyResult.isErr()) return err(pubKeyResult.error);
    const publicKeyJwk: ProvPublicKeyJwk | null = pubKeyResult.value;
    if (!publicKeyJwk) return err({ type: "public_key_export_failed" });
    const jwk = publicKeyJwkSchema.safeParse(publicKeyJwk);
    // A signer whose exported key is not an Ed25519 OKP JWK cannot produce the attestation's
    // signature form — the keypair is corrupt for this purpose, before any signing runs.
    if (!jwk.success) return err({ type: "keypair_corrupt", cause: jwk.error });

    return computePayloadDigest(provJson).andThen((digest) =>
        signer.sign(digest).map((signature): ProvAttestation => ({
            payloadType: "application/json; profile=prov-json" as const,
            payloadDigestAlgorithm: "SHA-256" as const,
            payloadDigest: digest,
            payloadDigestMethod: "verbatim" as const,
            signatureAlgorithm: "Ed25519" as const,
            signature,
            publicKey: jwk.data,
            kid: opts?.kid,
        })),
    );
}

/**
 * Verify a provenance payload against its parsed attestation: import the attestation's public key
 * and run {@link verifyPayload}. Corrupt keys are returned as `VerifyResult` statuses, not thrown.
 *
 * The public key is trusted solely because it travels in the attestation — an attacker who
 * replaces both the payload and the attestation (with their own key) passes verification. For
 * sharing over trusted channels this is fine; for stronger trust a host pins the signer's public
 * key and checks the attestation's key against the pinned one before calling this.
 */
export async function verifyAttestation(provJson: string, attestation: ProvAttestation): Promise<VerifyResult> {
    const keyResult = await importPublicKeyJwk(attestation.publicKey);
    if (keyResult.isErr()) return { status: "invalid-key" };
    return verifyPayload(provJson, attestation.payloadDigest, attestation.signature, keyResult.value);
}
