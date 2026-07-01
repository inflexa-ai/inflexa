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
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();

        const provJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const chainHash = (await computeChainHash(null, provJson))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, chainHash))._unsafeUnwrap();

        const result = await verifyProvenance(provJson, null, chainHash, signature, kp.publicKey);
        expect(result.status).toBe("valid");
    });

    test("valid: correct chain hash and signature (second flush, prevChainHash set)", async () => {
        useTempKeyDir();
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();

        const firstJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const firstHash = (await computeChainHash(null, firstJson))._unsafeUnwrap();

        const secondJson = '{"entity":{"inflexa:analysis-a1":{"extra":true}}}';
        const secondHash = (await computeChainHash(firstHash, secondJson))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, secondHash))._unsafeUnwrap();

        const result = await verifyProvenance(secondJson, firstHash, secondHash, signature, kp.publicKey);
        expect(result.status).toBe("valid");
    });

    test("tampered: modified PROV-JSON produces chain hash mismatch", async () => {
        useTempKeyDir();
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();

        const originalJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const chainHash = (await computeChainHash(null, originalJson))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, chainHash))._unsafeUnwrap();

        const tamperedJson = '{"entity":{"inflexa:analysis-a1":{"tampered":true}}}';
        const result = await verifyProvenance(tamperedJson, null, chainHash, signature, kp.publicKey);
        expect(result.status).toBe("tampered");
        expect(result.status === "tampered" && result.detail).toContain("chain hash mismatch");
    });

    test("tampered: modified signature fails Ed25519 verification", async () => {
        useTempKeyDir();
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();

        const provJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const chainHash = (await computeChainHash(null, provJson))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, chainHash))._unsafeUnwrap();
        const flipped = signature.slice(0, -2) + (signature.slice(-2) === "00" ? "01" : "00");

        const result = await verifyProvenance(provJson, null, chainHash, flipped, kp.publicKey);
        expect(result.status).toBe("tampered");
        expect(result.status === "tampered" && result.detail).toContain("signature verification failed");
    });
});

describe("verifyPayload (file-path, simple content digest)", () => {
    test("valid: correct digest and signature", async () => {
        useTempKeyDir();
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();

        const provJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const digest = (await computePayloadDigest(provJson))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, digest))._unsafeUnwrap();

        const result = await verifyPayload(provJson, digest, signature, kp.publicKey);
        expect(result.status).toBe("valid");
    });

    test("tampered: modified file produces digest mismatch", async () => {
        useTempKeyDir();
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();

        const originalJson = '{"entity":{"inflexa:analysis-a1":{}}}';
        const digest = (await computePayloadDigest(originalJson))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, digest))._unsafeUnwrap();

        const tamperedJson = '{"entity":{"inflexa:analysis-a1":{"tampered":true}}}';
        const result = await verifyPayload(tamperedJson, digest, signature, kp.publicKey);
        expect(result.status).toBe("tampered");
        expect(result.status === "tampered" && result.detail).toContain("payload digest mismatch");
    });
});

/**
 * Run `fn` with console.log captured into a string. Restores console.log and process.exitCode
 * on exit (even if `fn` throws), so one test's side effects don't leak into the next.
 */
async function captureConsole(fn: () => Promise<void>): Promise<{ output: string; exitCode: typeof process.exitCode }> {
    const origLog = console.log;
    const origExitCode = process.exitCode;
    let output = "";
    console.log = (msg: string) => {
        output += msg;
    };
    try {
        await fn();
        return { output, exitCode: process.exitCode };
    } finally {
        console.log = origLog;
        process.exitCode = origExitCode;
    }
}

describe("runVerifyFile (file-based verification, no DB)", () => {
    async function writeSignedProvFile(dir: string): Promise<{ provPath: string; provJson: string }> {
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();

        const provJson = '{"entity":{"inflexa:analysis-file-test":{}}}';
        const digest = (await computePayloadDigest(provJson))._unsafeUnwrap();
        const signature = (await signHexDigest(kp.privateKey, digest))._unsafeUnwrap();

        const { exportPublicKeyJwk } = await import("./signing.ts");
        const publicKey = (await exportPublicKeyJwk())._unsafeUnwrap();

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

        const { output } = await captureConsole(() => runVerifyFile(provPath));
        expect(output).toContain("verified");
    });

    test("tampered: modified provenance file is detected", async () => {
        useTempKeyDir();
        const { provPath } = await writeSignedProvFile(tempDir!);

        writeFileSync(provPath, '{"entity":{"inflexa:analysis-file-test":{"tampered":true}}}');

        const { output, exitCode } = await captureConsole(() => runVerifyFile(provPath));
        expect(output).toContain("FAILED");
        expect(exitCode).toBe(1);
    });

    test("missing sidecar: reports that verification is not possible", async () => {
        useTempKeyDir();
        const provPath = join(tempDir!, "no-sidecar.json");
        writeFileSync(provPath, '{"entity":{}}');

        const { output } = await captureConsole(() => runVerifyFile(provPath));
        expect(output).toContain("No sidecar found");
    });
});
