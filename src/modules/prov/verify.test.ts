import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";

import { verifyProvenance, verifyPayload, runVerifyFile } from "./verify.ts";
import { computeChainHash, computePayloadDigest, signHexDigest, loadOrGenerateKeypair, resetSigningForTests } from "./signing.ts";

let tempDir: string | null = null;

function useTempKeyDir(): string {
    const dir = join(tmpdir(), `prov-verify-test-${randomUUIDv7()}`);
    mkdirSync(dir, { recursive: true });
    resetSigningForTests(join(dir, "prov_key.json"));
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

describe("verifyProvenance (DB-path, chain hash verification)", () => {
    test("empty: null provenance → status empty", async () => {
        const result = await verifyProvenance(null, null, null, null, null);
        expect(result.status).toBe("empty");
    });

    test("unsigned: provenance present but no chain hash or signature", async () => {
        const result = await verifyProvenance('{"some":"prov"}', null, null, null, null);
        expect(result.status).toBe("unsigned");
    });

    test("no-key: signature exists but no public key provided", async () => {
        const result = await verifyProvenance('{"some":"prov"}', null, "abcd".repeat(16), "ef01".repeat(32), null);
        expect(result.status).toBe("no-key");
    });

    test("valid: correct chain hash and signature (first flush, prevChainHash = null)", async () => {
        useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();

        const provJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const chainHash = await computeChainHash(null, provJson);
        const signature = await signHexDigest(kp!.privateKey, chainHash);

        const result = await verifyProvenance(provJson, null, chainHash, signature, kp!.publicKey);
        expect(result.status).toBe("valid");
    });

    test("valid: correct chain hash and signature (second flush, prevChainHash set)", async () => {
        useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();

        const firstJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const firstHash = await computeChainHash(null, firstJson);

        const secondJson = '{"entity":{"inflexa:analysis-a1":{"extra":true}}}';
        const secondHash = await computeChainHash(firstHash, secondJson);
        const signature = await signHexDigest(kp!.privateKey, secondHash);

        const result = await verifyProvenance(secondJson, firstHash, secondHash, signature, kp!.publicKey);
        expect(result.status).toBe("valid");
    });

    test("tampered: modified PROV-JSON produces chain hash mismatch", async () => {
        useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();

        const originalJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const chainHash = await computeChainHash(null, originalJson);
        const signature = await signHexDigest(kp!.privateKey, chainHash);

        const tamperedJson = '{"entity":{"inflexa:analysis-a1":{"tampered":true}}}';
        const result = await verifyProvenance(tamperedJson, null, chainHash, signature, kp!.publicKey);
        expect(result.status).toBe("tampered");
        expect(result.status === "tampered" && result.detail).toContain("chain hash mismatch");
    });

    test("tampered: modified signature fails Ed25519 verification", async () => {
        useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();

        const provJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const chainHash = await computeChainHash(null, provJson);
        const signature = await signHexDigest(kp!.privateKey, chainHash);
        const flipped = signature.slice(0, -2) + (signature.slice(-2) === "00" ? "01" : "00");

        const result = await verifyProvenance(provJson, null, chainHash, flipped, kp!.publicKey);
        expect(result.status).toBe("tampered");
        expect(result.status === "tampered" && result.detail).toContain("signature verification failed");
    });
});

describe("verifyPayload (file-path, simple content digest)", () => {
    test("valid: correct digest and signature", async () => {
        useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();

        const provJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const digest = await computePayloadDigest(provJson);
        const signature = await signHexDigest(kp!.privateKey, digest);

        const result = await verifyPayload(provJson, digest, signature, kp!.publicKey);
        expect(result.status).toBe("valid");
    });

    test("tampered: modified file produces digest mismatch", async () => {
        useTempKeyDir();
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();

        const originalJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const digest = await computePayloadDigest(originalJson);
        const signature = await signHexDigest(kp!.privateKey, digest);

        const tamperedJson = '{"entity":{"inflexa:analysis-a1":{"tampered":true}}}';
        const result = await verifyPayload(tamperedJson, digest, signature, kp!.publicKey);
        expect(result.status).toBe("tampered");
        expect(result.status === "tampered" && result.detail).toContain("payload digest mismatch");
    });
});

describe("runVerifyFile (file-based verification, no DB)", () => {
    async function writeSignedProvFile(dir: string): Promise<{ provPath: string; provJson: string }> {
        const kp = await loadOrGenerateKeypair();
        expect(kp).not.toBeNull();

        const provJson = '{"entity":{"inflexa:analysis-file-test":{}}}';
        const digest = await computePayloadDigest(provJson);
        const signature = await signHexDigest(kp!.privateKey, digest);

        const { exportPublicKeyJwk } = await import("./signing.ts");
        const publicKey = await exportPublicKeyJwk();

        const provPath = join(dir, "provenance.json");
        writeFileSync(provPath, provJson);

        const sidecar = {
            payloadType: "application/json; profile=prov-json",
            payloadDigestAlgorithm: "SHA-256",
            payloadDigest: digest,
            payloadDigestMethod: "verbatim",
            signatureAlgorithm: "Ed25519",
            signature,
            publicKey,
        };
        writeFileSync(`${provPath}.sig.json`, JSON.stringify(sidecar, null, 2));
        return { provPath, provJson };
    }

    test("valid: provenance file + sidecar verify successfully", async () => {
        useTempKeyDir();
        const { provPath } = await writeSignedProvFile(tempDir!);

        const origLog = console.log;
        let output = "";
        console.log = (msg: string) => {
            output += msg;
        };
        await runVerifyFile(provPath);
        console.log = origLog;

        expect(output).toContain("verified");
    });

    test("tampered: modified provenance file is detected", async () => {
        useTempKeyDir();
        const { provPath } = await writeSignedProvFile(tempDir!);

        writeFileSync(provPath, '{"entity":{"inflexa:analysis-file-test":{"tampered":true}}}');

        const origLog = console.log;
        let output = "";
        console.log = (msg: string) => {
            output += msg;
        };
        await runVerifyFile(provPath);
        console.log = origLog;

        expect(output).toContain("FAILED");
        expect(process.exitCode).toBe(1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- resetting exitCode to 0 after the tampered test so it doesn't leak into the test runner's exit status
        (process as any).exitCode = 0;
    });

    test("missing sidecar: reports that verification is not possible", async () => {
        useTempKeyDir();
        const provPath = join(tempDir!, "no-sidecar.json");
        writeFileSync(provPath, '{"entity":{}}');

        const origLog = console.log;
        let output = "";
        console.log = (msg: string) => {
            output += msg;
        };
        await runVerifyFile(provPath);
        console.log = origLog;

        expect(output).toContain("No sidecar found");
    });
});
