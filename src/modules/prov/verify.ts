import { readFileSync, existsSync } from "node:fs";
import type { VerifyResult } from "../../types/prov.ts";
import type { IdOrName } from "../../lib/types.ts";
import { getAnalysisIntegrity } from "../../db/primary_query.ts";
import { findAnalysisForProv } from "./document.ts";
import { computeChainHash, verifyChainHash, loadPublicKey } from "./signing.ts";
import { dieOn, fail } from "../../lib/cli.ts";

/**
 * Pure verification: recompute the chain hash from the stored PROV-JSON and check the signature.
 * All inputs are passed in — no DB or file I/O here, so the function is directly unit-testable.
 */
export async function verifyProvenance(
    provJson: string | null,
    storedChainHash: string | null,
    storedSignature: string | null,
    publicKey: CryptoKey | null,
): Promise<VerifyResult> {
    if (provJson === null) return { status: "empty" };
    if (storedChainHash === null || storedSignature === null) return { status: "unsigned" };
    if (publicKey === null) return { status: "no-key" };

    const recomputed = await computeChainHash(null, provJson);
    if (recomputed !== storedChainHash) {
        return { status: "tampered", detail: "chain hash mismatch: the PROV-JSON has been modified since it was signed" };
    }

    const ok = await verifyChainHash(publicKey, storedSignature, storedChainHash);
    if (!ok) {
        return { status: "tampered", detail: "signature verification failed: the chain hash or signature has been modified" };
    }

    return { status: "valid" };
}

/** Format a {@link VerifyResult} as a human-readable line for CLI output or TUI notice. */
export function formatVerifyResult(result: VerifyResult): string {
    switch (result.status) {
        case "valid":
            return "Provenance integrity verified: chain hash and signature are valid.";
        case "unsigned":
            return "Provenance is unsigned (recorded before integrity was enabled, or without a signing key).";
        case "tampered":
            return `Provenance integrity FAILED: ${result.detail}`;
        case "no-key":
            return "Cannot verify: a signature exists but the signing key file is missing.";
        case "empty":
            return "No provenance has been recorded for this analysis.";
    }
}

/**
 * CLI action for `inflexa prov verify <analysis>`: resolve the analysis, load integrity data
 * from the DB, load the public key, run verification, and print the result.
 */
export async function runVerifyProvenance(ref: string): Promise<void> {
    const analysis = findAnalysisForProv(ref as IdOrName).match((a) => a, dieOn("Failed to resolve analysis"));
    if (!analysis) fail(`No analysis found matching "${ref}".`);

    const integrity = getAnalysisIntegrity(analysis.id).match((i) => i, dieOn("Failed to read provenance"));
    if (!integrity) fail(`No analysis row for "${ref}".`);

    const publicKey = await loadPublicKey();
    const result = await verifyProvenance(integrity.provenance, integrity.chainHash, integrity.signature, publicKey);
    console.log(formatVerifyResult(result));

    if (result.status === "tampered") process.exitCode = 1;
}

/** The self-describing sidecar shape written by export.ts. */
type Sidecar = {
    payloadType: string;
    payloadDigestAlgorithm: string;
    payloadDigest: string;
    payloadDigestMethod: string;
    signatureAlgorithm: string;
    signature: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JWK is a loose object from the sidecar file; we pass it straight to crypto.subtle.importKey which validates it.
    publicKey: any;
};

function readSidecar(sigPath: string): Sidecar | null {
    try {
        return JSON.parse(readFileSync(sigPath, "utf-8")) as Sidecar;
    } catch {
        return null;
    }
}

/**
 * CLI action for `inflexa prov verify-file <path>`: verify an exported provenance file against
 * its `.sig.json` sidecar. No database or analysis row needed — a colleague who receives the
 * exported files can run this to confirm integrity.
 */
export async function runVerifyFile(path: string): Promise<void> {
    if (!existsSync(path)) fail(`File not found: ${path}`);

    const sigPath = `${path}.sig.json`;
    if (!existsSync(sigPath)) {
        console.log("No sidecar found: the provenance file cannot be verified without a .sig.json sidecar.");
        return;
    }

    const sidecar = readSidecar(sigPath);
    if (!sidecar?.payloadDigest || !sidecar.signature || !sidecar.publicKey) {
        fail(`Sidecar at ${sigPath} is missing required fields.`);
    }

    // TODO(robustness): the public key is trusted solely because it travels in the sidecar — an
    // attacker who replaces both the provenance file and the sidecar (with their own key) passes
    // verification. For teammate-to-teammate sharing over trusted channels this is fine; for stronger
    // trust, support key pinning: the verifier registers the signer's public key once, then future
    // verify-file calls check the sidecar's key against the pinned one.
    let publicKey: CryptoKey;
    try {
        publicKey = await crypto.subtle.importKey("jwk", sidecar.publicKey, "Ed25519", true, ["verify"]);
    } catch {
        fail("The public key in the sidecar is invalid or unsupported.");
    }

    const provJson = readFileSync(path, "utf-8");
    const result = await verifyProvenance(provJson, sidecar.payloadDigest, sidecar.signature, publicKey);
    console.log(formatVerifyResult(result));

    if (result.status === "tampered") process.exitCode = 1;
}
