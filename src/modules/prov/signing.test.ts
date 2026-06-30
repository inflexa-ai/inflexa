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
        const result = await loadOrGenerateKeypair();
        expect(result.isOk()).toBe(true);
        const raw = Bun.file(join(dir, "prov_key.json"));
        expect(await raw.exists()).toBe(true);
        const stored = await raw.json();
        expect(stored.publicKey.kty).toBe("OKP");
        expect(stored.publicKey.crv).toBe("Ed25519");
    });

    test("loads an existing keypair from disk", async () => {
        useTempKeyDir();
        const r1 = await loadOrGenerateKeypair();
        expect(r1.isOk()).toBe(true);
        resetSigningForTests(join(tempDir!, "prov_key.json"));
        const r2 = await loadOrGenerateKeypair();
        expect(r2.isOk()).toBe(true);
        const hash = (await computeChainHash(null, "test"))._unsafeUnwrap();
        const sig1 = (await signHexDigest(r1._unsafeUnwrap().privateKey, hash))._unsafeUnwrap();
        const sig2 = (await signHexDigest(r2._unsafeUnwrap().privateKey, hash))._unsafeUnwrap();
        expect(sig1).toBe(sig2);
    });

    test("corrupt keypair file is replaced with a fresh keypair", async () => {
        const dir = useTempKeyDir();
        writeFileSync(join(dir, "prov_key.json"), "not json");
        const result = await loadOrGenerateKeypair();
        expect(result.isOk()).toBe(true);
        const stored = await Bun.file(join(dir, "prov_key.json")).json();
        expect(stored.publicKey.kty).toBe("OKP");
    });

    test("structurally valid but wrong JWK returns keypair_corrupt error", async () => {
        const dir = useTempKeyDir();
        writeFileSync(join(dir, "prov_key.json"), JSON.stringify({ publicKey: { kty: "BAD" }, privateKey: { kty: "BAD" } }));
        const result = await loadOrGenerateKeypair();
        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().type).toBe("keypair_corrupt");
    });

    test("loadPublicKey returns null when no file exists", async () => {
        useTempKeyDir();
        expect(await loadPublicKey()).toBeNull();
    });
});

describe("chain hash computation", () => {
    test("initial chain hash uses SHA-256 of empty as the seed", async () => {
        const h = (await computeChainHash(null, "hello"))._unsafeUnwrap();
        expect(h).toHaveLength(64);
        expect((await computeChainHash(null, "hello"))._unsafeUnwrap()).toBe(h);
    });

    test("different provenance JSON produces a different chain hash", async () => {
        const h1 = (await computeChainHash(null, '{"a":1}'))._unsafeUnwrap();
        const h2 = (await computeChainHash(null, '{"a":2}'))._unsafeUnwrap();
        expect(h1).not.toBe(h2);
    });

    test("chaining from a previous hash differs from the initial seed", async () => {
        const h1 = (await computeChainHash(null, "first"))._unsafeUnwrap();
        const h2 = (await computeChainHash(h1, "second"))._unsafeUnwrap();
        const hAlt = (await computeChainHash(null, "second"))._unsafeUnwrap();
        expect(h2).not.toBe(hAlt);
    });
});

describe("sign and verify", () => {
    test("round-trip: sign then verify succeeds", async () => {
        useTempKeyDir();
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();
        const hash = (await computeChainHash(null, '{"provenance":"data"}'))._unsafeUnwrap();
        const sig = (await signHexDigest(kp.privateKey, hash))._unsafeUnwrap();
        expect(sig).toHaveLength(128);
        const valid = (await verifyHexDigest(kp.publicKey, sig, hash))._unsafeUnwrap();
        expect(valid).toBe(true);
    });

    test("tampered chain hash fails verification", async () => {
        useTempKeyDir();
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();
        const hash = (await computeChainHash(null, "original"))._unsafeUnwrap();
        const sig = (await signHexDigest(kp.privateKey, hash))._unsafeUnwrap();
        const tampered = (await computeChainHash(null, "modified"))._unsafeUnwrap();
        const valid = (await verifyHexDigest(kp.publicKey, sig, tampered))._unsafeUnwrap();
        expect(valid).toBe(false);
    });

    test("Ed25519 signature is deterministic", async () => {
        useTempKeyDir();
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();
        const hash = (await computeChainHash(null, "deterministic"))._unsafeUnwrap();
        const sig1 = (await signHexDigest(kp.privateKey, hash))._unsafeUnwrap();
        const sig2 = (await signHexDigest(kp.privateKey, hash))._unsafeUnwrap();
        expect(sig1).toBe(sig2);
    });
});
