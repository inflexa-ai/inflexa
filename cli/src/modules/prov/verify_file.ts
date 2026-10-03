import { existsSync, readFileSync } from "node:fs";
import { attestationSchema, verifyAttestation, type ProvAttestation } from "@inflexa-ai/prov-kernel";

import type { VerifyResult } from "../../types/prov.ts";

// The verification of an exported provenance file against its `.sig.json` attestation. It reads the two
// files and nothing else — no database, no key file, no server — thus a colleague who receives the export
// can run it, and the TUI client runs it on the machine that holds the files.

/** Parse a `.sig.json` attestation file, returning `null` on missing/corrupt/malformed. */
function readAttestation(sigPath: string): ProvAttestation | null {
    try {
        return JSON.parseWith(readFileSync(sigPath, "utf-8"), attestationSchema);
    } catch {
        return null;
    }
}

/**
 * Verify an exported provenance file against its `.sig.json` attestation. Shared by the CLI
 * `prov verify-file` action and the TUI "Verify provenance (export)" command — both need the same
 * read-attestation → verify pipeline. Returns `null` when no attestation exists. Corrupt
 * attestations and invalid keys are returned as `VerifyResult` statuses, not thrown — callers
 * handle them the same way as any other verification outcome.
 *
 * // TODO(robustness): the public key is trusted solely because it travels in the attestation — an
 * // attacker who replaces both the provenance file and the attestation (with their own key) passes
 * // verification. For teammate-to-teammate sharing over trusted channels this is fine; for stronger
 * // trust, support key pinning: the verifier registers the signer's public key once, then future
 * // verify calls check the attestation's key against the pinned one.
 */
export async function verifyExportFile(provPath: string): Promise<VerifyResult | null> {
    const sigPath = `${provPath}.sig.json`;
    if (!existsSync(sigPath)) return null;

    const attestation = readAttestation(sigPath);
    if (!attestation) return { status: "invalid-attestation", detail: `attestation at ${sigPath} is invalid or missing required fields` };

    let provJson: string;
    try {
        provJson = readFileSync(provPath, "utf-8");
    } catch {
        return { status: "tampered", detail: `provenance file at ${provPath} is missing or unreadable` };
    }
    return verifyAttestation(provJson, attestation);
}
