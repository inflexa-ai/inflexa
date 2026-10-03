import { resolve } from "node:path";

import { formatVerifyResult } from "@inflexa-ai/prov-kernel";

import type { ProvExportFormat } from "../../api/provenance.ts";
import { fail } from "../../lib/cli.ts";
import { describeClientError, DEFAULT_CLIENT_OPTS, type ClientOpts } from "../api.ts";
import { createProvenanceExport, fetchLineage, fetchProvenanceVerification } from "../provenance.ts";

/** The analysis that a provenance command acts on: the id for the route, the name for the output. */
export type ProvAnalysis = { id: string; name: string };

/** The `--format` values of `prov export`, and the export format of the route for each. */
const EXPORT_FORMATS = { json: "prov-json", provn: "prov-n" } as const satisfies Record<string, ProvExportFormat>;

/**
 * `inflexa prov export <analysis> [--format json|provn] [--output <file>]` — the server flushes the recorder
 * and serializes the provenance of the analysis. By DEFAULT it writes `provenance.<format>` into the output
 * folder of the analysis; `--output <file>` overrides the destination, relative to the working folder of
 * this command. A JSON export also gets its `.sig.json` attestation, with a content digest and an Ed25519
 * signature for third-party verification.
 */
export async function provExport(analysis: ProvAnalysis, flags: { format?: string; output?: string }, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const flag = (flags.format ?? "json").toLowerCase();
    if (flag !== "json" && flag !== "provn") fail(`Unknown format "${flags.format}". Use "json" or "provn".`);
    const output = flags.output === undefined ? {} : { output: resolve(process.cwd(), flags.output) };
    (await createProvenanceExport(analysis.id, { format: EXPORT_FORMATS[flag], ...output }, opts)).match(
        (exported) => {
            console.log(`Wrote ${flag} provenance for "${analysis.name}" to ${exported.path}`);
            if (exported.attestationPath !== undefined) console.log(`Wrote verification attestation to ${exported.attestationPath}`);
        },
        (e) => fail(describeClientError(e)),
    );
}

/** `inflexa prov verify <analysis>` — the server checks the signed chain of the analysis; this prints the verdict. */
export async function provVerify(analysis: ProvAnalysis, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const result = (await fetchProvenanceVerification(analysis.id, opts)).match(
        (r) => r,
        (e) => fail(describeClientError(e)),
    );
    console.log(formatVerifyResult(result));
    if (result.status === "tampered" || result.status === "verify-error") process.exitCode = 1;
}

/**
 * `inflexa prov lineage <analysis> <ref> [--forward] [--depth n] [--format tree|json|dot|mermaid]` — the
 * server resolves the ref (a file path, content hash, hash prefix, search string, or record QName) in the
 * stored provenance of the analysis and walks its lineage. The server validates each option, and names the
 * candidates of an ambiguous ref. This command checks `--depth` first, because the route names its query
 * parameter, not the flag.
 */
export async function provLineage(
    analysis: ProvAnalysis,
    ref: string,
    flags: { forward?: boolean; depth?: string; format?: string },
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): Promise<void> {
    if (flags.depth !== undefined) {
        const depth = Number(flags.depth);
        if (!Number.isInteger(depth) || depth < 1) fail(`--depth must be a positive integer, got "${flags.depth}".`);
    }
    const view = (await fetchLineage(analysis.id, { ref, ...flags }, opts)).match(
        (v) => v,
        (e) => fail(describeClientError(e)),
    );
    console.log(view.format === "json" ? JSON.stringify(view.lineage, null, 2) : view.text);
}
