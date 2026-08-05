import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    computeChainHash,
    computePayloadDigest,
    createKeypairSigner,
    importPrivateKeyJwk,
    importPublicKeyJwk,
    signHexDigest,
    verifyHexDigest,
} from "./signing.js";

async function makeKeypair(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
}

function sha256Hex(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

describe("chain hash", () => {
    test("the first link seeds with SHA-256 of the empty string", async () => {
        const json = `{"prefix":{"inflexa":"https://inflexa.ai/prov#"}}`;
        const seed = createHash("sha256").update(Buffer.alloc(0)).digest();
        const expected = sha256Hex(Buffer.concat([seed, Buffer.from(json, "utf8")]));
        expect((await computeChainHash(null, json))._unsafeUnwrap()).toBe(expected);
    });

    test("a later link chains SHA-256(prev || json)", async () => {
        const h1 = (await computeChainHash(null, `{"a":1}`))._unsafeUnwrap();
        const h2 = (await computeChainHash(h1, `{"b":2}`))._unsafeUnwrap();
        const expected = sha256Hex(Buffer.concat([Buffer.from(h1, "hex"), Buffer.from(`{"b":2}`, "utf8")]));
        expect(h2).toBe(expected);
        expect(h2).not.toBe((await computeChainHash(null, `{"b":2}`))._unsafeUnwrap());
    });
});

describe("payload digest", () => {
    test("computePayloadDigest is SHA-256 over the exact payload bytes", async () => {
        const json = `{"a":1}`;
        expect((await computePayloadDigest(json))._unsafeUnwrap()).toBe(sha256Hex(Buffer.from(json, "utf8")));
    });
});

describe("Ed25519 sign/verify", () => {
    test("a signed digest verifies with the matching public key", async () => {
        const kp = await makeKeypair();
        const digest = (await computePayloadDigest(`{"a":1}`))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, digest))._unsafeUnwrap();
        expect(signature).toMatch(/^[0-9a-f]{128}$/);
        expect((await verifyHexDigest(kp.publicKey, signature, digest))._unsafeUnwrap()).toBe(true);
    });

    test("a tampered digest or foreign signature fails verification", async () => {
        const kp = await makeKeypair();
        const digest = (await computePayloadDigest(`{"a":1}`))._unsafeUnwrap();
        const other = (await computePayloadDigest(`{"a":2}`))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, digest))._unsafeUnwrap();
        expect((await verifyHexDigest(kp.publicKey, signature, other))._unsafeUnwrap()).toBe(false);

        const foreign = await makeKeypair();
        expect((await verifyHexDigest(foreign.publicKey, signature, digest))._unsafeUnwrap()).toBe(false);
    });

    test("a JWK-imported keypair signs and verifies", async () => {
        const kp = await makeKeypair();
        const privateJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as Record<string, unknown>;
        const publicJwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as Record<string, unknown>;

        const privateKey = (await importPrivateKeyJwk(privateJwk))._unsafeUnwrap();
        const publicKey = (await importPublicKeyJwk(publicJwk))._unsafeUnwrap();
        const digest = (await computePayloadDigest(`{"a":1}`))._unsafeUnwrap();
        const signature = (await signHexDigest(privateKey, digest))._unsafeUnwrap();
        expect((await verifyHexDigest(publicKey, signature, digest))._unsafeUnwrap()).toBe(true);

        expect((await importPublicKeyJwk({ kty: "OKP" }))._unsafeUnwrapErr().type).toBe("crypto_failed");
    });

    test("the keypair signer binds sign and JWK export to its pair", async () => {
        const kp = await makeKeypair();
        const signer = createKeypairSigner(kp);
        const digest = (await computePayloadDigest(`{"a":1}`))._unsafeUnwrap();
        const signature = (await signer.sign(digest))._unsafeUnwrap();
        expect((await verifyHexDigest(kp.publicKey, signature, digest))._unsafeUnwrap()).toBe(true);

        const jwk = (await signer.exportPublicKeyJwk())._unsafeUnwrap();
        expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    });
});
