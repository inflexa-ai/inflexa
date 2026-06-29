import { readFileSync, writeFileSync, mkdirSync, linkSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { type Result, ok, err } from "neverthrow";
import { env } from "../../lib/env.ts";
import { getLogger } from "../../lib/log.ts";

/**
 * Ed25519 provenance signing: keypair lifecycle (generate-on-first-use, JWK persistence) and the
 * sign/verify/chain-hash operations the recorder and verifier call. Confined to this file so a
 * WebCrypto fault is contained to provenance integrity, not recording.
 *
 * The keypair lives at `env.provKeyPath` as `{ publicKey: JWK, privateKey: JWK }`. Provenance is
 * never written unsigned — every failure to obtain the keypair surfaces as a `SigningError` on
 * the err channel, forcing the caller to handle or propagate rather than silently skip signing.
 */

const log = getLogger("prov:signing");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- WebCrypto's JsonWebKey is a loose object; we serialize it as-is without inspecting fields.
type JWK = any;

/** The on-disk JWK keypair shape. */
type StoredKeypair = { publicKey: JWK; privateKey: JWK };

/** In-memory imported keypair — cached for the process lifetime to avoid re-importing on every flush. */
export type ImportedKeypair = { publicKey: CryptoKey; privateKey: CryptoKey };

/** Why a signing operation could not obtain the keypair. Every variant is a hard failure — provenance is never written unsigned. */
export type SigningError =
    | { type: "keypair_corrupt"; cause?: unknown }
    | { type: "keypair_generation_failed"; cause: unknown }
    | { type: "keypair_race_lost" }
    | { type: "public_key_export_failed" };

let cached: ImportedKeypair | null = null;
// Set after a parseable-but-unimportable JWK is encountered, so we don't re-read the file and
// retry crypto.subtle.importKey on every flush cycle for the rest of the process.
let importFailed = false;

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

/**
 * Atomically persist the keypair: write to a PID-stamped temp file, then hard-link to the
 * target path. `linkSync` fails with EEXIST if another process already created the file,
 * so the winner's key is never overwritten. Returns `"created"` if this process won,
 * `"exists"` if a valid keypair already occupies the path. If the existing file is corrupt
 * (unparseable — e.g. leftover from a crash), removes it and retries the link once.
 */
function writeKeypairFileExclusive(stored: StoredKeypair): "created" | "exists" {
    const target = keyPath();
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
        // Hard-link is atomic and exclusive — fails EEXIST if target was created between
        // our readKeypairFile() miss and now, preventing the second process from silently
        // clobbering the first's key.
        try {
            linkSync(tmp, target);
            return "created";
        } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            // Target exists — check if it's a valid keypair from a concurrent winner, or
            // corrupt debris (e.g. a crash left partial JSON). If corrupt, remove and retry
            // the link once; a concurrent process that wins the retry will have a valid file.
            if (readKeypairFile()) return "exists";
            try {
                unlinkSync(target);
                linkSync(tmp, target);
                return "created";
            } catch (retryErr: unknown) {
                if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") return "exists";
                throw retryErr;
            }
        }
    } finally {
        try {
            unlinkSync(tmp);
        } catch {
            // temp may not exist if writeFileSync failed before creating it
        }
    }
}

/**
 * Load the signing keypair from disk, or generate and persist one on first use. Returns
 * `err(SigningError)` when the keypair cannot be obtained — provenance is never written unsigned.
 * Cached for the process lifetime.
 *
 * Race-safe: if two processes both miss the read and generate concurrently, the exclusive write
 * ensures exactly one wins; the loser adopts the winner's key from disk.
 */
export async function loadOrGenerateKeypair(): Promise<Result<ImportedKeypair, SigningError>> {
    if (cached) return ok(cached);
    if (importFailed) return err({ type: "keypair_corrupt" });

    const stored = readKeypairFile();
    if (stored) {
        try {
            cached = await importKeypair(stored);
            return ok(cached);
        } catch (cause) {
            importFailed = true;
            return err({ type: "keypair_corrupt", cause });
        }
    }

    try {
        const kp = await generateKeypair();
        const exported = await exportKeypair(kp);
        if (writeKeypairFileExclusive(exported) === "exists") {
            const winner = readKeypairFile();
            if (!winner) return err({ type: "keypair_race_lost" });
            try {
                cached = await importKeypair(winner);
            } catch (cause) {
                importFailed = true;
                return err({ type: "keypair_corrupt", cause });
            }
            log.info("adopted provenance signing keypair from concurrent process");
            return ok(cached);
        }
        cached = { publicKey: kp.publicKey, privateKey: kp.privateKey };
        log.info("generated provenance signing keypair");
        return ok(cached);
    } catch (cause) {
        return err({ type: "keypair_generation_failed", cause });
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
 * without access to the keypair file. Prefers the in-memory cached key (avoiding a file re-read
 * that could race with another process writing a different keypair); falls back to disk when the
 * keypair hasn't been loaded yet. Returns `null` when no keypair is available.
 */
export async function exportPublicKeyJwk(): Promise<JWK | null> {
    if (cached) return crypto.subtle.exportKey("jwk", cached.publicKey);
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

/** Simple `SHA-256(provJson)` — the self-contained content digest used in the export sidecar. */
export async function computePayloadDigest(provJson: string): Promise<string> {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(provJson)));
    return bytesToHex(hash);
}

// --- Sign / Verify ---

/** Sign a hex-encoded digest with the Ed25519 private key, returning a hex-encoded 64-byte signature. */
export async function signHexDigest(privateKey: CryptoKey, digestHex: string): Promise<string> {
    const data = hexToBytes(digestHex);
    // Safe: hexToBytes allocates a fresh Uint8Array, so .buffer starts at offset 0 and is not shared.
    const sig = await crypto.subtle.sign("Ed25519", privateKey, data.buffer as ArrayBuffer);
    return bytesToHex(new Uint8Array(sig));
}

/** Verify a hex-encoded Ed25519 signature against a hex-encoded digest and a public key. */
export async function verifyHexDigest(publicKey: CryptoKey, signatureHex: string, digestHex: string): Promise<boolean> {
    const sig = hexToBytes(signatureHex);
    const data = hexToBytes(digestHex);
    // Safe: both Uint8Arrays are freshly allocated by hexToBytes — offset 0, not shared.
    return crypto.subtle.verify("Ed25519", publicKey, sig.buffer as ArrayBuffer, data.buffer as ArrayBuffer);
}

/** Reset the cached keypair and optionally override the key path — test-only. */
export function resetSigningForTests(overridePath?: string | null): void {
    cached = null;
    importFailed = false;
    keyPathOverride = overridePath ?? null;
}
