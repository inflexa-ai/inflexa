import { describe, expect, test } from "bun:test";
import { computeChainHash, computePayloadDigest, createKeypairSigner, signHexDigest } from "../signing.js";
import { buildAttestation, formatVerifyResult, attestationSchema, verifyProvenance, verifyAttestation } from "../verify.js";

async function makeKeypair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
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

    test("a missing kid leaves the key off the attestation", async () => {
        const kp = await makeKeypair();
        const attestation = (await buildAttestation(createKeypairSigner(kp), provJson))._unsafeUnwrap();
        expect("kid" in attestation).toBe(false);
        expect(JSON.parse(JSON.stringify(attestation))).not.toHaveProperty("kid");
        expect(await verifyAttestation(provJson, attestation)).toEqual({ status: "valid" });
    });

    test("a modified payload reads tampered", async () => {
        const kp = await makeKeypair();
        const attestation = (await buildAttestation(createKeypairSigner(kp), provJson))._unsafeUnwrap();
        expect(await verifyAttestation(`${provJson} `, attestation)).toMatchObject({ status: "tampered" });
    });

    test("a structurally valid but cryptographically wrong key reads invalid-key", async () => {
        const kp = await makeKeypair();
        const attestation = (await buildAttestation(createKeypairSigner(kp), provJson))._unsafeUnwrap();
        const corrupt = attestationSchema.parse({ ...attestation, publicKey: { kty: "OKP", crv: "Ed25519", x: "AAAA" } });
        expect(await verifyAttestation(provJson, corrupt)).toEqual({ status: "invalid-key" });
    });

    test("a JWK that is not an Ed25519 OKP key fails the schema; further JWK members parse", async () => {
        const kp = await makeKeypair();
        const attestation = (await buildAttestation(createKeypairSigner(kp), provJson))._unsafeUnwrap();
        expect(attestationSchema.safeParse({ ...attestation, publicKey: { kty: "EC" } }).success).toBe(false);
        expect(attestationSchema.safeParse({ ...attestation, publicKey: { kty: "OKP", crv: "X25519", x: "ab" } }).success).toBe(false);
        expect(attestationSchema.safeParse({ ...attestation, publicKey: { kty: "OKP", crv: "Ed25519" } }).success).toBe(false);
        const parsed = attestationSchema.parse({ ...attestation, publicKey: { ...attestation.publicKey, use: "sig", kid: "signer-1" } });
        expect(parsed.publicKey.kid).toBe("signer-1");
    });
});

describe("formatVerifyResult", () => {
    test("every status renders a line", () => {
        expect(formatVerifyResult({ status: "valid" })).toContain("verified");
        expect(formatVerifyResult({ status: "tampered", detail: "x" })).toContain("x");
        expect(formatVerifyResult({ status: "unsigned" })).toContain("unsigned");
    });
});
