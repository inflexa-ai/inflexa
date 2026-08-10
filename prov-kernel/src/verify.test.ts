import { describe, expect, test } from "bun:test";
import { computeChainHash, computePayloadDigest, createKeypairSigner, signHexDigest } from "./signing.js";
import { buildAttestation, formatVerifyResult, attestationSchema, verifyProvenance, verifyAttestation } from "./verify.js";

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

describe("attestation", () => {
    test("buildAttestation output parses under attestationSchema and verifies", async () => {
        const kp = await makeKeypair();
        const signer = createKeypairSigner(kp);

        const attestationResult = await buildAttestation(signer, provJson);
        expect(attestationResult.isOk()).toBe(true);
        const attestation = attestationSchema.parse(attestationResult._unsafeUnwrap());
        expect(attestation.payloadDigest).toBe((await computePayloadDigest(provJson))._unsafeUnwrap());
        expect(await verifyAttestation(provJson, attestation)).toEqual({ status: "valid" });
    });

    test("a kid rides the attestation and does not affect verification", async () => {
        const kp = await makeKeypair();
        const attestation = (await buildAttestation(createKeypairSigner(kp), provJson, { kid: "signer-1" }))._unsafeUnwrap();
        expect(attestationSchema.parse(attestation).kid).toBe("signer-1");
        expect(await verifyAttestation(provJson, attestation)).toEqual({ status: "valid" });
    });

    test("a modified payload reads tampered", async () => {
        const kp = await makeKeypair();
        const attestation = (await buildAttestation(createKeypairSigner(kp), provJson))._unsafeUnwrap();
        expect(await verifyAttestation(`${provJson} `, attestation)).toMatchObject({ status: "tampered" });
    });

    test("a corrupt public key reads invalid-key", async () => {
        const kp = await makeKeypair();
        const attestation = (await buildAttestation(createKeypairSigner(kp), provJson))._unsafeUnwrap();
        expect(await verifyAttestation(provJson, { ...attestation, publicKey: { kty: "OKP" } })).toEqual({ status: "invalid-key" });
    });
});

describe("formatVerifyResult", () => {
    test("every status renders a line", () => {
        expect(formatVerifyResult({ status: "valid" })).toContain("verified");
        expect(formatVerifyResult({ status: "tampered", detail: "x" })).toContain("x");
        expect(formatVerifyResult({ status: "unsigned" })).toContain("unsigned");
    });
});
