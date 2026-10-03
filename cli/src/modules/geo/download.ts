import { join } from "node:path";

import { fail } from "../../lib/cli.ts";
import { isDirWritable } from "../anchor/marker.ts";
import { downloadGeoSeries, parseByteSize, parseGseAccession, type GeoDownloadError, type GeoProgress } from "./geo.ts";

/**
 * A human way-forward for a failed GEO download.
 *
 * Exported for its tests: the command never threads a fetch seam into `downloadGeoSeries`, so no end-to-end
 * run can reach these arms without an upstream, and a remedy that does not actually work — a `--max-size`
 * the Series still fails — is a user-facing defect with nothing else to catch it.
 */
export function describeGeoDownloadError(error: GeoDownloadError, accession: string): string {
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
        // Its own arm rather than one more transport fault: a stall is the one failure here that the
        // same command can clear on its own, so the line ends with the remedy instead of a full stop.
        case "stalled":
            return `Downloading ${accession} stopped: ${error.message}\nNothing was downloaded — re-run to start again.`;
    }
}

/** Print one line per transfer phase — a captured subprocess has nowhere to paint a live meter. */
function reportProgress(event: GeoProgress): void {
    switch (event.type) {
        case "skipped":
            // On stderr, and never silently: the closing line claims the Series was downloaded, and a
            // name GEO published that this machine cannot reproduce is the one way that claim overstates
            // what landed. The user gets the name and the directory, which is enough to fetch it by hand.
            console.warn(`  ! skipping ${event.fileName} — its name cannot be written to disk (${event.dirUrl})`);
            return;
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
 * `inflexa geo download <GSE>` — fetch a GEO Series' processed data into the analysis's folder.
 *
 * Download only. It writes files and touches nothing else: no input rows, no provenance, no staging,
 * no profiling, no harness runtime. That is what makes it safe to run as a subprocess beside a live
 * TUI — it never contends for the analysis instance lock, because it never mutates the analysis. The
 * Series becomes an input the moment the user asks for it, through the same add-inputs path any local
 * file uses, so this command owns no part of enrollment.
 *
 * `resolveFolder` gives the target folder, and the caller resolves it through the server
 * (`client/commands/geo.ts`). An agent-driven run with no `--analysis` thus lands in the chat analysis's
 * folder — `run_inflexa` starts the child there, so the ordinary marker walk-up already points at it. It
 * runs after the two argument checks, thus a bad argument fails before any request.
 */
export async function runGeoDownload(rawGse: string, maxSize: string | undefined, resolveFolder: () => Promise<string>): Promise<void> {
    const accession = parseGseAccession(rawGse).match(
        (a) => a,
        () => fail(`Not a GEO Series accession: "${rawGse}" (expected e.g. GSE12345).`),
    );
    const maxBytes = maxSize === undefined ? undefined : parseByteSize(maxSize);
    if (maxSize !== undefined && maxBytes === undefined) fail(`Not a size: "${maxSize}" (expected e.g. 500MB, 64GB, or a plain byte count).`);
    const folder = await resolveFolder();
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
