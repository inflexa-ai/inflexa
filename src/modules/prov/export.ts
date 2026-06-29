import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuiltinProvFormat } from "@inflexa-ai/tsprov";
import { findAnalysisForProv, serializeProvenance } from "./document.ts";
import { buildSidecar } from "./verify.ts";
import { ensureOutputDir } from "../analysis/output.ts";
import { dieOn, fail } from "../../lib/cli.ts";

// The export action lives in the `prov` module. Its one cross-module import is `analysis/output.ts`
// for the default destination (the analysis's own `.inflexa` output folder); `output.ts` imports
// `anchor`/`env`, NOT `prov`, so this opens no dependency cycle back into `prov`.

/**
 * `inflexa prov export <analysis> [--format json|provn] [--output <file>]` — serialize an analysis's
 * provenance document. By DEFAULT writes `provenance.<format>` into the analysis's output folder
 * (under `.inflexa/`, created if needed); `--output <file>` overrides the destination. When a
 * signing key is available, a sidecar `.sig.json` is written alongside with a content digest and
 * Ed25519 signature for third-party verification.
 */
export async function runExportProvenance(ref: string, opts: { format?: string; output?: string }): Promise<void> {
    const format = parseFormat(opts.format);
    const analysis = findAnalysisForProv(ref).match((a) => a, dieOn("Failed to resolve analysis"));
    if (!analysis) fail(`No analysis found matching "${ref}".`);

    const document = serializeProvenance(analysis, format).match((s) => s, dieOn("Failed to build provenance"));

    const dest = opts.output ?? ensureOutputDir(analysis).match((dir) => join(dir, `provenance.${format}`), dieOn("Failed to resolve output directory"));
    try {
        writeFileSync(dest, document);
    } catch (cause) {
        fail(`Failed to write ${dest}`, cause);
    }
    console.log(`Wrote ${format} provenance for "${analysis.name}" to ${dest}`);

    // Sidecar is only meaningful for JSON exports — the payloadType claim must match the actual
    // format, and PROV-N is a lossy re-serialization unverifiable against the chain hash.
    if (format === "json") {
        await writeSidecar(document, dest);
    }
}

/**
 * Write the verification sidecar (`<dest>.sig.json`) by computing a content digest of the
 * exported provenance and signing it. Silently skipped when no signing key is available.
 */
async function writeSidecar(provJson: string, provDest: string): Promise<void> {
    const sidecar = await buildSidecar(provJson);
    if (!sidecar) return;

    const sigDest = `${provDest}.sig.json`;
    try {
        writeFileSync(sigDest, JSON.stringify(sidecar, null, 2));
        console.log(`Wrote verification sidecar to ${sigDest}`);
    } catch {
        // Non-fatal: the provenance file was already written successfully.
        console.warn(`Warning: could not write sidecar to ${sigDest}`);
    }
}

/** Validate the `--format` flag against tsprov's built-in formats, defaulting to `json`. */
function parseFormat(raw: string | undefined): BuiltinProvFormat {
    const f = (raw ?? "json").toLowerCase();
    if (f === "json" || f === "provn") return f;
    fail(`Unknown format "${raw}". Use "json" or "provn".`);
}
