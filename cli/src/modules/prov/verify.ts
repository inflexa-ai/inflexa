import { readFileSync, existsSync } from "node:fs";
import { type Result, err } from "neverthrow";
import {
    buildSidecar as buildSidecarWithSigner,
    createKeypairSigner,
    formatVerifyResult,
    sidecarSchema,
    verifyProvenance,
    verifySidecar,
    type ProvSigningError,
    type Sidecar,
} from "@inflexa-ai/prov-kernel";
import type { VerifyResult } from "../../types/prov.ts";
import { getAnalysisIntegrity } from "../../db/primary_query.ts";
import { requireAnalysisForProv } from "./prov.ts";
import { getLogger } from "../../lib/log.ts";
import { loadOrGenerateKeypair, loadPublicKey } from "./signing.ts";
import { fail } from "../../lib/cli.ts";

// The cli's verification surface: the storage reads (DB integrity columns, `.sig.json` files, the
// key file) and the command wiring around `@inflexa-ai/prov-kernel`'s verify/sidecar primitives.
// The verification logic and the sidecar schema are the kernel's.

const log = getLogger("prov:verify");

/**
 * Verify an analysis's stored provenance from its DB integrity columns: load the integrity data,
 * load the public key, and run the kernel's chained verification. Returns `null` only when the
 * analysis row does not exist. Shared by the CLI `prov verify` action and the TUI palette command.
 */
export async function verifyAnalysisIntegrity(analysisId: string): Promise<VerifyResult | null> {
    const integrity = getAnalysisIntegrity(analysisId).match(
        (i) => i,
        (e) => {
            log.error({ analysisId, err: e.type, cause: e.cause }, "failed to read integrity columns");
            return null;
        },
    );
    if (!integrity) return null;

    const publicKey = await loadPublicKey();
    return verifyProvenance(integrity.provenance, integrity.prevChainHash, integrity.chainHash, integrity.signature, publicKey);
}

/**
 * CLI action for `inflexa prov verify <analysis>`: resolve the analysis, load integrity data
 * from the DB, load the public key, run verification, and print the result.
 */
export async function runVerifyProvenance(ref: string): Promise<void> {
    const analysis = requireAnalysisForProv(ref);

    const result = await verifyAnalysisIntegrity(analysis.id);
    if (!result) fail(`No analysis row for "${ref}".`);

    console.log(formatVerifyResult(result));
    if (result.status === "tampered" || result.status === "verify-error") process.exitCode = 1;
}

/**
 * Build a sidecar for an exported provenance file, signed with THIS machine's keypair file
 * (generated on first use). Returns `err(ProvSigningError)` when the signing key is unavailable —
 * provenance is never exported unsigned.
 */
export async function buildSidecar(provJson: string): Promise<Result<Sidecar, ProvSigningError>> {
    const kpResult = await loadOrGenerateKeypair();
    if (kpResult.isErr()) return err(kpResult.error);
    return buildSidecarWithSigner(createKeypairSigner(kpResult.value), provJson);
}

/** Parse a `.sig.json` sidecar file, returning `null` on missing/corrupt/malformed. */
export function readSidecar(sigPath: string): Sidecar | null {
    try {
        return JSON.parseWith(readFileSync(sigPath, "utf-8"), sidecarSchema);
    } catch {
        return null;
    }
}

/**
 * Verify an exported provenance file against its `.sig.json` sidecar. Shared by the CLI
 * `prov verify-file` action and the TUI "Verify provenance (export)" command — both need the same
 * read-sidecar → verify pipeline. Returns `null` when no sidecar exists. Corrupt sidecars and
 * invalid keys are returned as `VerifyResult` statuses, not thrown — callers handle them the same
 * way as any other verification outcome.
 *
 * // TODO(robustness): the public key is trusted solely because it travels in the sidecar — an
 * // attacker who replaces both the provenance file and the sidecar (with their own key) passes
 * // verification. For teammate-to-teammate sharing over trusted channels this is fine; for stronger
 * // trust, support key pinning: the verifier registers the signer's public key once, then future
 * // verify calls check the sidecar's key against the pinned one.
 */
export async function verifyExportFile(provPath: string): Promise<VerifyResult | null> {
    const sigPath = `${provPath}.sig.json`;
    if (!existsSync(sigPath)) return null;

    const sidecar = readSidecar(sigPath);
    if (!sidecar) return { status: "invalid-sidecar", detail: `sidecar at ${sigPath} is invalid or missing required fields` };

    let provJson: string;
    try {
        provJson = readFileSync(provPath, "utf-8");
    } catch {
        return { status: "tampered", detail: `provenance file at ${provPath} is missing or unreadable` };
    }
    return verifySidecar(provJson, sidecar);
}

/**
 * CLI action for `inflexa prov verify-file <path>`: verify an exported provenance file against
 * its `.sig.json` sidecar. No database or analysis row needed — a colleague who receives the
 * exported files can run this to confirm integrity.
 */
export async function runVerifyFile(path: string): Promise<void> {
    if (!existsSync(path)) fail(`File not found: ${path}`);

    const result = await verifyExportFile(path);
    if (!result) {
        console.log("No sidecar found: the provenance file cannot be verified without a .sig.json sidecar.");
        return;
    }
    console.log(formatVerifyResult(result));
    if (result.status === "tampered" || result.status === "invalid-sidecar" || result.status === "invalid-key" || result.status === "verify-error")
        process.exitCode = 1;
}
