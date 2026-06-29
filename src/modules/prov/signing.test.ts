import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";

import { loadOrGenerateKeypair, loadPublicKey, computeChainHash, signHexDigest, verifyHexDigest, resetSigningForTests } from "./signing.ts";

let tempDir: string | null = null;

function useTempKeyDir(): string {
    const dir = join(tmpdir(), `prov-signing-test-${randomUUIDv7()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "prov_key.json");
    resetSigningForTests(path);
    tempDir = dir;
    return dir;
}

afterEach(() => {
    resetSigningForTests(null);
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
});

describe("keypair lifecycle", () => {
    test("generates a keypair on first call and persists it", async () => {
        const dir = useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();
        const raw = Bun.file(join(dir, "prov_key.json"));
        expect(await raw.exists()).toBe(true);
        const stored = await raw.json();
        expect(stored.publicKey.kty).toBe("OKP");
        expect(stored.publicKey.crv).toBe("Ed25519");
    });

    test("loads an existing keypair from disk", async () => {
        useTempKeyDir();
        const kp1 = await loadOrGenerateKeypair();
        expect(kp1).not.toBeNull();
        // Drop the in-memory cache, keep the file path, reload from disk.
        resetSigningForTests(join(tempDir!, "prov_key.json"));
        const kp2 = await loadOrGenerateKeypair();
        expect(kp2).not.toBeNull();
        // Both keypairs sign the same data to the same signature (Ed25519 is deterministic).
        const hash = await computeChainHash(null, "test");
        const sig1 = await signHexDigest(kp1!.privateKey, hash);
        const sig2 = await signHexDigest(kp2!.privateKey, hash);
        expect(sig1).toBe(sig2);
    });

    test("corrupt keypair file is replaced with a fresh keypair", async () => {
        const dir = useTempKeyDir();
        writeFileSync(join(dir, "prov_key.json"), "not json");
        // readKeypairFile returns null for unparseable JSON, so loadOrGenerateKeypair falls
        // through to generate a fresh one — the user gets signing rather than silent degradation.
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();
        // The file on disk now contains a valid keypair.
        const stored = await Bun.file(join(dir, "prov_key.json")).json();
        expect(stored.publicKey.kty).toBe("OKP");
    });

    test("structurally valid but wrong JWK degrades to null", async () => {
        const dir = useTempKeyDir();
        // A file that parses as JSON but has bogus JWK contents — importKey will throw.
        writeFileSync(join(dir, "prov_key.json"), JSON.stringify({ publicKey: { kty: "BAD" }, privateKey: { kty: "BAD" } }));
        const kp = await loadOrGenerateKeypair();
        expect(kp).toBeNull();
    });

    test("loadPublicKey returns null when no file exists", async () => {
        useTempKeyDir();
        expect(await loadPublicKey()).toBeNull();
    });
});

describe("chain hash computation", () => {
    test("initial chain hash uses SHA-256 of empty as the seed", async () => {
        const h = await computeChainHash(null, "hello");
        expect(h).toHaveLength(64);
        expect(await computeChainHash(null, "hello")).toBe(h);
    });

    test("different provenance JSON produces a different chain hash", async () => {
        const h1 = await computeChainHash(null, '{"a":1}');
        const h2 = await computeChainHash(null, '{"a":2}');
        expect(h1).not.toBe(h2);
    });

    test("chaining from a previous hash differs from the initial seed", async () => {
        const h1 = await computeChainHash(null, "first");
        const h2 = await computeChainHash(h1, "second");
        const hAlt = await computeChainHash(null, "second");
        expect(h2).not.toBe(hAlt);
    });
});

describe("sign and verify", () => {
    test("round-trip: sign then verify succeeds", async () => {
        useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();
        const hash = await computeChainHash(null, '{"provenance":"data"}');
        const sig = await signHexDigest(kp!.privateKey, hash);
        expect(sig).toHaveLength(128);
        const ok = await verifyHexDigest(kp!.publicKey, sig, hash);
        expect(ok).toBe(true);
    });

    test("tampered chain hash fails verification", async () => {
        useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();
        const hash = await computeChainHash(null, "original");
        const sig = await signHexDigest(kp!.privateKey, hash);
        const tampered = await computeChainHash(null, "modified");
        const ok = await verifyHexDigest(kp!.publicKey, sig, tampered);
        expect(ok).toBe(false);
    });

    test("Ed25519 signature is deterministic", async () => {
        useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();
        const hash = await computeChainHash(null, "deterministic");
        const sig1 = await signHexDigest(kp!.privateKey, hash);
        const sig2 = await signHexDigest(kp!.privateKey, hash);
        expect(sig1).toBe(sig2);
    });
});
