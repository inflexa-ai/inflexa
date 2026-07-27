import { join } from "node:path";

import { dieOn, fail } from "../../lib/cli.ts";
import { resolveContext, type ContextFlags } from "../analysis/context.ts";
import { isDirWritable } from "../anchor/marker.ts";
import { downloadGeoSeries, parseByteSize, parseGseAccession, type GeoDownloadError, type GeoProgress } from "./geo.ts";

/**
 * The folder a downloaded Series lands in — the analysis's home folder, not its workspace.
 *
 * Resolution needs an analysis only to reach that folder, so both a resolved analysis and a bare
 * anchor answer the question and neither branch reads the analysis itself. Mirrors how profile/run
 * resolve their target, minus the single-analysis requirement they need and this does not: several
 * analyses in one folder still share the one folder to download into.
 */
function resolveTargetFolder(flags: ContextFlags): string {
    const ctx = resolveContext(process.cwd(), flags).match((c) => c, dieOn("Could not resolve the folder to download into"));
    switch (ctx.kind) {
        case "analysis":
        case "anchor":
            return ctx.anchorPath;
        case "pick": {
            // `pick` covers two different situations, and telling a user who just passed `--analysis`
            // to pass `--analysis` is the unhelpful half: an unmatched ref lands here too.
            const known = ctx.analyses.length === 0 ? "" : `\nKnown analyses:\n${ctx.analyses.map((a) => `  - ${a.id}  ${a.name}`).join("\n")}`;
            return fail(
                flags.analysis === undefined
                    ? `More than one analysis could match — pass --analysis <id|name> to choose whose folder to download into.${known}`
                    : `No analysis matches "${flags.analysis}".${known}`,
            );
        }
        case "copy":
            return fail("This folder looks copied — run `inflexa repair` or `inflexa relocate` before downloading into it.");
        case "empty":
            return fail("No analysis here — run `inflexa new` to create one, or pass --analysis <id|name>.");
    }
}

/** A human way-forward for a failed GEO download. */
function describeGeoDownloadError(error: GeoDownloadError, accession: string): string {
    switch (error.type) {
        case "no_processed_files":
            return `${accession} exposes no downloadable processed files (SOFT / matrix / supplementary). Check the accession on the GEO site — a Series whose data is under embargo lists nothing. Nothing was downloaded.`;
        case "unreachable":
            return `Could not reach GEO for ${accession}: ${error.message}\nNCBI rate-limits bursts; wait a minute and re-run.`;
        case "too_large":
            return `${accession} declares ${error.declaredBytes.formatBytes()}, above the ${error.cap.formatBytes()} per-Series ceiling. Nothing was downloaded — re-run with --max-size ${Math.ceil(error.declaredBytes / 1024 ** 3)}GB to allow it.`;
        case "insecure_redirect":
        case "http_failed":
        case "io_failed":
            return `Downloading ${accession} failed: ${error.message}\nNothing was downloaded.`;
    }
}

/** Print one line per transfer phase — a captured subprocess has nowhere to paint a live meter. */
function reportProgress(event: GeoProgress): void {
    switch (event.type) {
        case "resolved": {
            const total = event.size.sized === 0 ? "size unknown" : `${event.size.declaredBytes.formatBytes()}${event.size.unsized > 0 ? "+" : ""}`;
            console.log(`Resolved ${event.files} file(s), ${total}.`);
            return;
        }
        case "file_started":
            console.log(
                `  [${event.index + 1}/${event.total}] ${event.fileName}${event.declaredBytes === undefined ? "" : ` (${event.declaredBytes.formatBytes()})`}`,
            );
            return;
        case "file_progress": {
            const of = event.declaredBytes === undefined ? "" : ` / ${event.declaredBytes.formatBytes()}`;
            console.log(`      ${event.bytes.formatBytes()}${of}`);
            return;
        }
        case "file_completed":
            console.log(`      done — ${event.bytes.formatBytes()}`);
            return;
    }
}

/**
 * `inflexa geo add <GSE>` — download a GEO Series' processed data into the analysis's folder.
 *
 * Download only. It writes files and touches nothing else: no input rows, no provenance, no staging,
 * no profiling, no harness runtime. That is what makes it safe to run as a subprocess beside a live
 * TUI — it never contends for the analysis instance lock, because it never mutates the analysis. The
 * Series becomes an input the moment the user asks for it, through the same add-inputs path any local
 * file uses, so this command owns no part of enrollment.
 *
 * The target folder resolves through `resolveContext`, so an agent-driven run with no `--analysis`
 * lands in the chat analysis's folder — `run_inflexa` starts the child there, so the ordinary marker
 * walk-up already points at it.
 */
export async function runGeoAdd(rawGse: string, flags: ContextFlags, maxSize?: string): Promise<void> {
    const accession = parseGseAccession(rawGse).match(
        (a) => a,
        () => fail(`Not a GEO Series accession: "${rawGse}" (expected e.g. GSE12345).`),
    );
    const maxBytes = maxSize === undefined ? undefined : parseByteSize(maxSize);
    if (maxSize !== undefined && maxBytes === undefined) fail(`Not a size: "${maxSize}" (expected e.g. 500MB, 64GB, or a plain byte count).`);
    const folder = resolveTargetFolder(flags);
    // Checked before the transfer rather than after: a read-only folder is a property of the user's
    // filesystem with an obvious remedy, and discovering it only once the bytes have moved wastes them.
    if (!isDirWritable(folder)) fail(`${folder} is not writable, so ${accession} cannot be downloaded there.`);

    const destDir = join(folder, accession);
    console.log(`Downloading ${accession} to ${destDir}`);
    const downloaded = await downloadGeoSeries(accession, destDir, { onProgress: reportProgress, ...(maxBytes === undefined ? {} : { maxBytes }) });
    if (downloaded.isErr()) fail(describeGeoDownloadError(downloaded.error, accession));

    console.log(`\nDownloaded ${accession} — ${downloaded.value.length} file(s) in ${destDir}.`);
    console.log("These are files on disk, not analysis inputs yet. Ask to add them as inputs when you want them staged and profiled.");
}
