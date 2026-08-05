import { describe, expect, test } from "bun:test";
import { computeChainHash, computePayloadDigest, createKeypairSigner, signHexDigest } from "./signing.js";
import { buildSidecar, formatVerifyResult, sidecarSchema, verifyProvenance, verifySidecar } from "./verify.js";

async function makeKeypair(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
}

const provJson = `{"prefix":{"inflexa":"https://inflexa.ai/prov#"}}`;

describe("verifyProvenance", () => {
    test("a correct chain link with a matching signature is valid", async () => {
        const kp = await makeKeypair();
        const chainHash = (await computeChainHash(null, provJson))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, chainHash))._unsafeUnwrap();
        expect(await verifyProvenance(provJson, null, chainHash, signature, kp.publicKey)).toEqual({ status: "valid" });
    });

    test("a wrong prev chain hash reads tampered", async () => {
        const kp = await makeKeypair();
        const chainHash = (await computeChainHash(null, provJson))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, chainHash))._unsafeUnwrap();
        expect(await verifyProvenance(provJson, "ab".repeat(32), chainHash, signature, kp.publicKey)).toMatchObject({ status: "tampered" });
    });

    test("a signature over a different digest reads tampered", async () => {
        const kp = await makeKeypair();
        const chainHash = (await computeChainHash(null, provJson))._unsafeUnwrap();
        const wrongSignature = (await signHexDigest(kp.privateKey, (await computePayloadDigest("other"))._unsafeUnwrap()))._unsafeUnwrap();
        expect(await verifyProvenance(provJson, null, chainHash, wrongSignature, kp.publicKey)).toMatchObject({ status: "tampered" });
    });

    test("the guard statuses: empty, unsigned, no-key", async () => {
        const kp = await makeKeypair();
        expect(await verifyProvenance(null, null, null, null, null)).toEqual({ status: "empty" });
        expect(await verifyProvenance(provJson, null, null, null, kp.publicKey)).toEqual({ status: "unsigned" });
        expect(await verifyProvenance(provJson, null, "ab".repeat(32), "cd".repeat(64), null)).toEqual({ status: "no-key" });
    });
});

describe("sidecar", () => {
    test("buildSidecar output parses under sidecarSchema and verifies", async () => {
        const kp = await makeKeypair();
        const signer = createKeypairSigner(kp);

        const sidecarResult = await buildSidecar(signer, provJson);
        expect(sidecarResult.isOk()).toBe(true);
        const sidecar = sidecarSchema.parse(sidecarResult._unsafeUnwrap());
        expect(sidecar.payloadDigest).toBe((await computePayloadDigest(provJson))._unsafeUnwrap());
        expect(await verifySidecar(provJson, sidecar)).toEqual({ status: "valid" });
    });

    test("a modified payload reads tampered", async () => {
        const kp = await makeKeypair();
        const sidecar = (await buildSidecar(createKeypairSigner(kp), provJson))._unsafeUnwrap();
        expect(await verifySidecar(`${provJson} `, sidecar)).toMatchObject({ status: "tampered" });
    });

    test("a corrupt public key reads invalid-key", async () => {
        const kp = await makeKeypair();
        const sidecar = (await buildSidecar(createKeypairSigner(kp), provJson))._unsafeUnwrap();
        expect(await verifySidecar(provJson, { ...sidecar, publicKey: { kty: "OKP" } })).toEqual({ status: "invalid-key" });
    });
});

describe("formatVerifyResult", () => {
    test("every status renders a line", () => {
        expect(formatVerifyResult({ status: "valid" })).toContain("verified");
        expect(formatVerifyResult({ status: "tampered", detail: "x" })).toContain("x");
        expect(formatVerifyResult({ status: "unsigned" })).toContain("unsigned");
    });
});
