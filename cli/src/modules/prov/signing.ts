import { readFileSync, writeFileSync, mkdirSync, linkSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { type Result, ResultAsync, ok, err } from "neverthrow";
import { importPrivateKeyJwk, importPublicKeyJwk, type ProvSigningError } from "@inflexa-ai/prov-kernel";
import { env } from "../../lib/env.ts";
import { getLogger } from "../../lib/log.ts";

/**
 * The Ed25519 signing-key FILE lifecycle: generate-on-first-use, JWK persistence at
 * `env.provKeyPath`, and race-safe adoption across concurrent processes. The crypto primitives
 * themselves (chain hash, sign, verify, JWK import) are `@inflexa-ai/prov-kernel`'s; this module
 * owns only where the keypair lives on this machine.
 *
 * Provenance is never written unsigned — every failure to obtain the keypair surfaces as a
 * {@link ProvSigningError} on the err channel, forcing the caller to handle or propagate rather
 * than silently skip signing.
 */

const log = getLogger("prov:signing");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- WebCrypto's JsonWebKey is a loose object; we serialize it as-is without inspecting fields.
type JWK = any;

/** The on-disk JWK keypair shape. */
type StoredKeypair = { publicKey: JWK; privateKey: JWK };

/** In-memory imported keypair — cached for the process lifetime to avoid re-importing on every flush. */
export type ImportedKeypair = { publicKey: CryptoKey; privateKey: CryptoKey };

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

/** Import a stored JWK pair through the kernel's import primitives; a failed import is a corrupt keypair. */
function importKeypair(stored: StoredKeypair): ResultAsync<ImportedKeypair, ProvSigningError> {
    return ResultAsync.combine([importPublicKeyJwk(stored.publicKey), importPrivateKeyJwk(stored.privateKey)])
        .map(([publicKey, privateKey]): ImportedKeypair => ({ publicKey, privateKey }))
        .mapErr((e): ProvSigningError => ({ type: "keypair_corrupt", cause: e }));
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
 * `err(ProvSigningError)` when the keypair cannot be obtained — provenance is never written
 * unsigned. Cached for the process lifetime.
 *
 * Race-safe: if two processes both miss the read and generate concurrently, the exclusive write
 * ensures exactly one wins; the loser adopts the winner's key from disk.
 */
export async function loadOrGenerateKeypair(): Promise<Result<ImportedKeypair, ProvSigningError>> {
    if (cached) return ok(cached);
    if (importFailed) return err({ type: "keypair_corrupt" });

    const stored = readKeypairFile();
    if (stored) {
        const imported = await importKeypair(stored);
        if (imported.isErr()) {
            importFailed = true;
            return err(imported.error);
        }
        cached = imported.value;
        return ok(cached);
    }

    try {
        const kp = await generateKeypair();
        const exported = await exportKeypair(kp);
        if (writeKeypairFileExclusive(exported) === "exists") {
            const winner = readKeypairFile();
            if (!winner) return err({ type: "keypair_race_lost" });
            const imported = await importKeypair(winner);
            if (imported.isErr()) {
                importFailed = true;
                return err(imported.error);
            }
            cached = imported.value;
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
    return (await importPublicKeyJwk(stored.publicKey)).match(
        (key) => key,
        () => null,
    );
}

/** Reset the cached keypair and optionally override the key path — test-only. */
export function resetSigningForTests(overridePath?: string | null): void {
    cached = null;
    importFailed = false;
    keyPathOverride = overridePath ?? null;
}
