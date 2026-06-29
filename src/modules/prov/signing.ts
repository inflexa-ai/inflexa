import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../../lib/env.ts";
import { getLogger } from "../../lib/log.ts";

/**
 * Ed25519 provenance signing: keypair lifecycle (generate-on-first-use, JWK persistence) and the
 * sign/verify/chain-hash operations the recorder and verifier call. Confined to this file so a
 * WebCrypto fault is contained to provenance integrity, not recording.
 *
 * The keypair lives at `env.provKeyPath` as `{ publicKey: JWK, privateKey: JWK }`. Missing or
 * corrupt file degrades to unsigned — the caller (flush) still writes provenance, just without
 * integrity columns.
 */

const log = getLogger("prov:signing");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- WebCrypto's JsonWebKey is a loose object; we serialize it as-is without inspecting fields.
type JWK = any;

/** The on-disk JWK keypair shape. */
type StoredKeypair = { publicKey: JWK; privateKey: JWK };

/** In-memory imported keypair — cached for the process lifetime to avoid re-importing on every flush. */
export type ImportedKeypair = { publicKey: CryptoKey; privateKey: CryptoKey };

let cached: ImportedKeypair | null = null;

/** Resolve the keypair file path — tests override via `keyPathOverride`; production uses `env.provKeyPath`. */
let keyPathOverride: string | null = null;

function keyPath(): string {
    return keyPathOverride ?? env.provKeyPath;
}

// --- Keypair lifecycle ---

async function generateKeypair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

async function exportKeypair(kp: CryptoKeyPair): Promise<StoredKeypair> {
    const [publicKey, privateKey] = await Promise.all([crypto.subtle.exportKey("jwk", kp.publicKey), crypto.subtle.exportKey("jwk", kp.privateKey)]);
    return { publicKey, privateKey };
}

async function importKeypair(stored: StoredKeypair): Promise<ImportedKeypair> {
    const [publicKey, privateKey] = await Promise.all([
        crypto.subtle.importKey("jwk", stored.publicKey, "Ed25519", true, ["verify"]),
        crypto.subtle.importKey("jwk", stored.privateKey, "Ed25519", true, ["sign"]),
    ]);
    return { publicKey, privateKey };
}

function readKeypairFile(): StoredKeypair | null {
    try {
        return JSON.parse(readFileSync(keyPath(), "utf-8")) as StoredKeypair;
    } catch {
        return null;
    }
}

function writeKeypairFile(stored: StoredKeypair): void {
    mkdirSync(dirname(keyPath()), { recursive: true });
    writeFileSync(keyPath(), JSON.stringify(stored, null, 2));
}

/**
 * Load the signing keypair from disk, or generate and persist one on first use. Returns `null`
 * when the file is corrupt and cannot be re-generated (should not happen in practice — generate
 * is infallible on supported runtimes). Cached for the process lifetime.
 */
export async function loadOrGenerateKeypair(): Promise<ImportedKeypair | null> {
    if (cached) return cached;

    const stored = readKeypairFile();
    if (stored) {
        try {
            cached = await importKeypair(stored);
            return cached;
        } catch (cause) {
            log.warn({ cause }, "corrupt provenance keypair file; provenance will be unsigned");
            return null;
        }
    }

    try {
        const kp = await generateKeypair();
        const exported = await exportKeypair(kp);
        writeKeypairFile(exported);
        cached = { publicKey: kp.publicKey, privateKey: kp.privateKey };
        log.info("generated provenance signing keypair");
        return cached;
    } catch (cause) {
        log.warn({ cause }, "failed to generate provenance keypair; provenance will be unsigned");
        return null;
    }
}

/**
 * Load only the public key (for verification when the private key is not needed). Returns `null`
 * when the file is missing or corrupt.
 */
export async function loadPublicKey(): Promise<CryptoKey | null> {
    if (cached) return cached.publicKey;
    const stored = readKeypairFile();
    if (!stored) return null;
    try {
        return await crypto.subtle.importKey("jwk", stored.publicKey, "Ed25519", true, ["verify"]);
    } catch {
        return null;
    }
}

/**
 * Export the public key as JWK for inclusion in an export sidecar — lets a third party verify
 * without access to the keypair file. Returns `null` when no keypair is available.
 */
export async function exportPublicKeyJwk(): Promise<JWK | null> {
    const stored = readKeypairFile();
    return stored?.publicKey ?? null;
}

// --- Chain hash ---

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
export async function computeChainHash(prevChainHashHex: string | null, provJson: string): Promise<string> {
    const prev = prevChainHashHex ? hexToBytes(prevChainHashHex) : await emptySeed();
    const jsonBytes = new TextEncoder().encode(provJson);
    const combined = new Uint8Array(prev.length + jsonBytes.length);
    combined.set(prev, 0);
    combined.set(jsonBytes, prev.length);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
    return bytesToHex(hash);
}

// --- Sign / Verify ---

/** Sign a hex-encoded chain hash with the private key, returning a hex-encoded 64-byte Ed25519 signature. */
export async function signChainHash(privateKey: CryptoKey, chainHashHex: string): Promise<string> {
    const data = hexToBytes(chainHashHex);
    const sig = await crypto.subtle.sign("Ed25519", privateKey, data.buffer as ArrayBuffer);
    return bytesToHex(new Uint8Array(sig));
}

/** Verify a hex-encoded signature against a hex-encoded chain hash and a public key. */
export async function verifyChainHash(publicKey: CryptoKey, signatureHex: string, chainHashHex: string): Promise<boolean> {
    const sig = hexToBytes(signatureHex);
    const data = hexToBytes(chainHashHex);
    return crypto.subtle.verify("Ed25519", publicKey, sig.buffer as ArrayBuffer, data.buffer as ArrayBuffer);
}

/** Reset the cached keypair and optionally override the key path — test-only. */
export function resetSigningForTests(overridePath?: string | null): void {
    cached = null;
    keyPathOverride = overridePath ?? null;
}
