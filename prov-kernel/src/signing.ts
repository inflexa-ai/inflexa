import { ResultAsync } from "neverthrow";

/**
 * Provenance signing primitives: the chain-hash and Ed25519 sign/verify operations a recorder,
 * the sidecar builder, and the verifier share — plus the {@link ProvSigner} seam through which a
 * host supplies key custody. Confined to this file so a WebCrypto fault is contained to provenance
 * integrity, not recording.
 *
 * Key LIFECYCLE (where a keypair lives, generate-on-first-use, rotation) is deliberately absent:
 * that is host policy behind {@link ProvSigner} — a CLI host keeps a config-dir JWK file, a
 * managed host mounts a secret. Provenance is never written unsigned — every failure surfaces as
 * a {@link ProvSigningError} on the err channel.
 */

/** WebCrypto's JsonWebKey is a loose object; it is carried as-is without inspecting fields. */
export type ProvPublicKeyJwk = Record<string, unknown>;

/** Why a signing/crypto operation failed. Every variant is a hard failure — provenance is never written unsigned. */
export type ProvSigningError =
    | { type: "keypair_corrupt"; cause?: unknown }
    | { type: "keypair_generation_failed"; cause: unknown }
    | { type: "keypair_race_lost" }
    | { type: "public_key_export_failed" }
    | { type: "crypto_failed"; op: string; cause: unknown };

/**
 * The signing seam a host fills at its composition root. `sign` receives a hex-encoded digest
 * (the chain hash at flush time, the payload digest at export time) and returns the hex-encoded
 * Ed25519 signature; `exportPublicKeyJwk` supplies the public half for sidecars and verification,
 * or `null` when no key exists yet.
 *
 * `exportPublicKeyJwk` may be called before any `sign` — the sidecar builder exports the public
 * key first. An implementation backed by a lazily-created keypair must generate the pair on
 * demand at export time, not fail because no `sign` has run yet.
 */
export interface ProvSigner {
    sign(digestHex: string): ResultAsync<string, ProvSigningError>;
    exportPublicKeyJwk(): ResultAsync<ProvPublicKeyJwk | null, ProvSigningError>;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    let hex = "";
    for (const b of bytes) {
        hex += b.toString(16).padStart(2, "0");
    }
    return hex;
}

/** The seed for the initial flush's chain hash: `SHA-256("")`, matching the RFC 6962 empty-tree convention. */
async function emptySeed(): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(0)));
}

/**
 * Compute the chain hash: `SHA-256(prevBytes || provJsonBytes)`. When `prevChainHashHex` is null
 * (first flush), the seed is `SHA-256("")`.
 */
export function computeChainHash(prevChainHashHex: string | null, provJson: string): ResultAsync<string, ProvSigningError> {
    return ResultAsync.fromPromise(
        (async () => {
            const prev = prevChainHashHex ? hexToBytes(prevChainHashHex) : await emptySeed();
            const jsonBytes = new TextEncoder().encode(provJson);
            const combined = new Uint8Array(prev.length + jsonBytes.length);
            combined.set(prev, 0);
            combined.set(jsonBytes, prev.length);
            const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
            return bytesToHex(hash);
        })(),
        (cause): ProvSigningError => ({ type: "crypto_failed", op: "computeChainHash", cause }),
    );
}

/** Simple `SHA-256(provJson)` — the self-contained content digest used in the export sidecar. */
export function computePayloadDigest(provJson: string): ResultAsync<string, ProvSigningError> {
    return ResultAsync.fromPromise(
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(provJson)).then((buf) => bytesToHex(new Uint8Array(buf))),
        (cause): ProvSigningError => ({ type: "crypto_failed", op: "computePayloadDigest", cause }),
    );
}

/** Import an Ed25519 private key from its JWK form (a JWK with `d`), ready for {@link signHexDigest}. */
export function importPrivateKeyJwk(jwk: Record<string, unknown>): ResultAsync<CryptoKey, ProvSigningError> {
    return ResultAsync.fromPromise(crypto.subtle.importKey("jwk", jwk as JsonWebKey, "Ed25519", false, ["sign"]), (cause): ProvSigningError => ({
        type: "crypto_failed",
        op: "importPrivateKeyJwk",
        cause,
    }));
}

/** Import an Ed25519 public key from its JWK form, ready for {@link verifyHexDigest}. */
export function importPublicKeyJwk(jwk: ProvPublicKeyJwk): ResultAsync<CryptoKey, ProvSigningError> {
    return ResultAsync.fromPromise(crypto.subtle.importKey("jwk", jwk as JsonWebKey, "Ed25519", true, ["verify"]), (cause): ProvSigningError => ({
        type: "crypto_failed",
        op: "importPublicKeyJwk",
        cause,
    }));
}

/** Sign a hex-encoded digest with an Ed25519 private key, returning a hex-encoded 64-byte signature. */
export function signHexDigest(privateKey: CryptoKey, digestHex: string): ResultAsync<string, ProvSigningError> {
    const data = hexToBytes(digestHex);
    // Safe: hexToBytes allocates a fresh Uint8Array, so .buffer starts at offset 0 and is not shared.
    return ResultAsync.fromPromise(
        crypto.subtle.sign("Ed25519", privateKey, data.buffer as ArrayBuffer).then((sig) => bytesToHex(new Uint8Array(sig))),
        (cause): ProvSigningError => ({ type: "crypto_failed", op: "signHexDigest", cause }),
    );
}

/** Verify a hex-encoded Ed25519 signature against a hex-encoded digest and a public key. */
export function verifyHexDigest(publicKey: CryptoKey, signatureHex: string, digestHex: string): ResultAsync<boolean, ProvSigningError> {
    const sig = hexToBytes(signatureHex);
    const data = hexToBytes(digestHex);
    // Safe: both Uint8Arrays are freshly allocated by hexToBytes — offset 0, not shared.
    return ResultAsync.fromPromise(
        crypto.subtle.verify("Ed25519", publicKey, sig.buffer as ArrayBuffer, data.buffer as ArrayBuffer),
        (cause): ProvSigningError => ({ type: "crypto_failed", op: "verifyHexDigest", cause }),
    );
}

/**
 * A {@link ProvSigner} over an in-memory Ed25519 keypair — for hosts that already hold imported
 * `CryptoKey`s (a managed host importing a mounted-secret JWK, tests generating a throwaway pair).
 * Key custody stays with the caller; this only binds the sign/export operations to the pair.
 */
export function createKeypairSigner(keypair: { privateKey: CryptoKey; publicKey: CryptoKey }): ProvSigner {
    return {
        sign: (digestHex) => signHexDigest(keypair.privateKey, digestHex),
        exportPublicKeyJwk: () =>
            ResultAsync.fromPromise(crypto.subtle.exportKey("jwk", keypair.publicKey) as Promise<ProvPublicKeyJwk>, (cause): ProvSigningError => ({
                type: "crypto_failed",
                op: "exportPublicKeyJwk",
                cause,
            })),
    };
}
