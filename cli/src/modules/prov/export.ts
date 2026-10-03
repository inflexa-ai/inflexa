import { dirname, join } from "node:path";
import type { BuiltinProvFormat } from "@inflexa-ai/tsprov";
import type { ProvAttestation, ProvSigningError } from "@inflexa-ai/prov-kernel";
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";

import type { DbError } from "../../db/errors.ts";
import { mkdirResult, writeFileResult } from "../../lib/fs.ts";
import type { Analysis } from "../../types/analysis.ts";
import { resolveOutputDir, type WorkspaceError } from "../analysis/output.ts";
import { serializeProvenance } from "./document.ts";
import { buildAttestation } from "./verify.ts";

// The export lives in the `prov` module. Its one cross-module import is `analysis/output.ts` for the
// default destination (the analysis's own `.inflexa` output folder); `output.ts` imports
// `anchor`/`env`, NOT `prov`, so this opens no dependency cycle back into `prov`.

/** Why an export wrote nothing, or wrote the document without its attestation. */
export type ExportProvenanceError =
    | { type: "output_dir"; error: WorkspaceError }
    | { type: "serialize"; error: DbError }
    /** No signing key: provenance is never exported unsigned, thus nothing was written. */
    | { type: "signing"; error: ProvSigningError }
    | { type: "write"; path: string; cause: unknown }
    /** The document landed at `path`, but its attestation did not. */
    | { type: "attestation_write"; path: string; cause: unknown };

/** Where an export landed. `attestationPath` is absent for PROV-N. */
export type ExportedProvenance = { path: string; attestationPath?: string };

/** The edges the export reads through. A test replaces them, to assert the ORDER on disk without a signing key or an anchored workspace. */
export type ExportProvenanceOpts = {
    /** The default destination folder: the live workspace root of the analysis. */
    readonly resolveOutputDir: typeof resolveOutputDir;
    readonly serializeProvenance: typeof serializeProvenance;
    readonly buildAttestation: typeof buildAttestation;
};

/** The production {@link ExportProvenanceOpts}. */
export const DEFAULT_EXPORT_PROVENANCE_OPTS: ExportProvenanceOpts = { resolveOutputDir, serializeProvenance, buildAttestation };

/**
 * Serialize the provenance of `analysis` to `output`, or to `provenance.<format>` in its output folder,
 * with the signed `.sig.json` attestation beside a JSON export. The caller flushes the recorder first.
 *
 * The attestation is built BEFORE either file is written, and a signing failure writes neither: an
 * unsigned document on disk would contradict the rule that provenance is never exported unsigned, and
 * the delete of an analysis exports on the user's behalf without being asked.
 *
 * Only a JSON export gets an attestation. The attestation claims the PROV-JSON payload type, and PROV-N
 * is a lossy rendering that the chain hash does not cover.
 *
 * The signature makes THIS document tamper-evident: a verifier can prove that the exported JSON was not
 * altered after signing, and its artifact hashes are recomputed host-side from disk. It does NOT attest
 * that the lineage the document records is a faithful account of what untrusted code did: the
 * read/write/delete edges are self-reported by hooks inside the sandbox, at the uid of the workload.
 */
export function exportAnalysisProvenance(
    analysis: Analysis,
    format: BuiltinProvFormat,
    output: string | undefined,
    opts: ExportProvenanceOpts = DEFAULT_EXPORT_PROVENANCE_OPTS,
): ResultAsync<ExportedProvenance, ExportProvenanceError> {
    // An `output` path names a file in a folder that the caller chose, thus the workspace is not resolved for it.
    const destination: Result<string, ExportProvenanceError> =
        output === undefined
            ? opts
                  .resolveOutputDir(analysis)
                  .map((dir) => join(dir, `provenance.${format}`))
                  .mapErr((error): ExportProvenanceError => ({ type: "output_dir", error }))
            : ok(output);
    return destination
        .andThen((path) =>
            opts
                .serializeProvenance(analysis, format)
                .map((document) => ({ path, document }))
                .mapErr((error): ExportProvenanceError => ({ type: "serialize", error })),
        )
        .asyncAndThen(({ path, document }) =>
            signIfJson(document, format, opts).andThen((attestation) => writeExport(path, document, attestation, output === undefined)),
        );
}

function signIfJson(document: string, format: BuiltinProvFormat, opts: ExportProvenanceOpts): ResultAsync<ProvAttestation | null, ExportProvenanceError> {
    if (format !== "json") return okAsync(null);
    return ResultAsync.fromSafePromise(opts.buildAttestation(document)).andThen((attestation) =>
        attestation.isOk() ? okAsync(attestation.value) : errAsync<ProvAttestation, ExportProvenanceError>({ type: "signing", error: attestation.error }),
    );
}

function writeExport(
    path: string,
    document: string,
    attestation: ProvAttestation | null,
    inWorkspace: boolean,
): Result<ExportedProvenance, ExportProvenanceError> {
    // The workspace folder is made here, after the signature, thus a signing failure leaves no folder
    // behind. The folder of an `output` path is not made: the caller chose it.
    const folder = inWorkspace ? mkdirResult(dirname(path), "exportProvenance:mkdir") : ok(undefined);
    const written = folder.andThen(() => writeFileResult(path, document, "exportProvenance:write"));
    if (written.isErr()) return err({ type: "write", path, cause: written.error.cause });
    if (attestation === null) return ok({ path });
    const attestationPath = `${path}.sig.json`;
    return writeFileResult(attestationPath, JSON.stringify(attestation, null, 2), "exportProvenance:attestation")
        .map((): ExportedProvenance => ({ path, attestationPath }))
        .mapErr((e): ExportProvenanceError => ({ type: "attestation_write", path, cause: e.cause }));
}
