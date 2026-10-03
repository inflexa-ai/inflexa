import { existsSync } from "node:fs";
import { type Result, err } from "neverthrow";
import {
    buildAttestation as buildAttestationWithSigner,
    createKeypairSigner,
    formatVerifyResult,
    verifyProvenance,
    type ProvAttestation,
    type ProvSigningError,
} from "@inflexa-ai/prov-kernel";
import type { VerifyResult } from "../../types/prov.ts";
import { getAnalysisIntegrity } from "../../db/primary_query.ts";
import { getLogger } from "../../lib/log.ts";
import { loadOrGenerateKeypair, loadPublicKey } from "./signing.ts";
import { fail } from "../../lib/cli.ts";
import { verifyExportFile } from "./verify_file.ts";

// The cli's verification surface: the storage reads (DB integrity columns, the key file) and the
// command wiring around `@inflexa-ai/prov-kernel`'s verify/attestation primitives. The read of an
// exported file and its `.sig.json` is in `verify_file.ts`, because the TUI client runs it too. The
// verification logic and the attestation schema are the kernel's.

const log = getLogger("prov:verify");

/**
 * Verify an analysis's stored provenance from its DB integrity columns: load the integrity data,
 * load the public key, and run the kernel's chained verification. Returns `null` when the analysis row
 * does not exist, or when its integrity columns cannot be read. The route `GET {A}/provenance/verify`
 * serves it to the `prov verify` command and to the TUI palette command.
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
 * Build an attestation for an exported provenance file, signed with THIS machine's keypair file
 * (generated on first use). Returns `err(ProvSigningError)` when the signing key is unavailable —
 * provenance is never exported unsigned.
 */
export async function buildAttestation(provJson: string): Promise<Result<ProvAttestation, ProvSigningError>> {
    const kpResult = await loadOrGenerateKeypair();
    if (kpResult.isErr()) return err(kpResult.error);
    return buildAttestationWithSigner(createKeypairSigner(kpResult.value), provJson);
}

/**
 * CLI action for `inflexa prov verify-file <path>`: verify an exported provenance file against
 * its `.sig.json` attestation. No database or analysis row needed — a colleague who receives the
 * exported files can run this to confirm integrity.
 */
export async function runVerifyFile(path: string): Promise<void> {
    if (!existsSync(path)) fail(`File not found: ${path}`);

    const result = await verifyExportFile(path);
    if (!result) {
        console.log("No attestation found: the provenance file cannot be verified without a .sig.json attestation.");
        return;
    }
    console.log(formatVerifyResult(result));
    if (result.status === "tampered" || result.status === "invalid-attestation" || result.status === "invalid-key" || result.status === "verify-error")
        process.exitCode = 1;
}
