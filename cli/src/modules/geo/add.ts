import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { dieOn, fail } from "../../lib/cli.ts";
import { ambientAnalysisRef, env } from "../../lib/env.ts";
import type { Analysis } from "../../types/analysis.ts";
import { applyInputsDiff } from "../analysis/analysis.ts";
import { resolveContext, type ContextFlags } from "../analysis/context.ts";
import { downloadGeoSeries, parseGseAccession, type GeoDownloadError } from "./geo.ts";

/** Collapse the resolved context to one analysis, or exit with a way-forward — mirrors how profile/run resolve their target. */
function resolveTargetAnalysis(flags: ContextFlags): Analysis {
    const ctx = resolveContext(process.cwd(), flags).match((c) => c, dieOn("Could not resolve the target analysis"));
    switch (ctx.kind) {
        case "analysis":
            return ctx.analysis;
        case "anchor": {
            const [only] = ctx.analyses;
            if (ctx.analyses.length === 1 && only) return only;
            return fail(
                ctx.analyses.length === 0
                    ? "No analysis here — run `inflexa new` to create one, or pass --analysis <id|name>."
                    : "This folder has multiple analyses — pass --analysis <id|name> to choose one.",
            );
        }
        case "pick":
            return fail("More than one analysis could match — pass --analysis <id|name>.");
        case "copy":
            return fail("This folder looks copied — re-mint or fork it before adding inputs.");
        case "empty":
            return fail("No analysis here — run `inflexa new` to create one, or pass --analysis <id|name>.");
    }
}

/** A human way-forward for a failed GEO download. */
function describeGeoDownloadError(error: GeoDownloadError, accession: string): string {
    switch (error.type) {
        case "no_processed_files":
            return `${accession} exposes no downloadable processed files (SOFT / matrix / supplementary). Nothing was added.`;
        case "unreachable":
            return `Could not reach GEO for ${accession}: ${error.message}`;
        case "insecure_redirect":
        case "http_failed":
        case "io_failed":
            return error.message;
    }
}

/**
 * `inflexa geo add <GSE>` — download a GEO Series' processed data and enroll it as inputs of the target
 * analysis.
 *
 * Enrollment only: it records the input rows and lands the bytes in a durable per-accession directory under
 * `env.geoDir` (never a temp dir — an enrolled row points at the path and the profiler stages from it
 * later). It never boots a harness runtime and never stages, so it is safe to run as a subprocess alongside
 * a live TUI; staging and (re)profiling are driven by whoever owns the runtime (the TUI, via run_inflexa's
 * post-action reconcile). The target analysis resolves through `resolveContext`, so an agent-driven run with
 * no `--analysis` targets the chat's analysis via the injected ambient ref.
 */
export async function runGeoAdd(rawGse: string, flags: ContextFlags): Promise<void> {
    const accession = parseGseAccession(rawGse).match(
        (a) => a,
        () => fail(`Not a GEO Series accession: "${rawGse}" (expected e.g. GSE12345).`),
    );
    const analysis = resolveTargetAnalysis({ ...flags, ambientAnalysis: ambientAnalysisRef() });

    const destDir = join(env.geoDir, accession);
    await mkdir(destDir, { recursive: true });
    const downloaded = await downloadGeoSeries(accession, destDir, {});
    if (downloaded.isErr()) fail(describeGeoDownloadError(downloaded.error, accession));

    const failures = applyInputsDiff(analysis.id, downloaded.value, [], process.cwd());
    if (failures[0]) fail(`Downloaded ${accession} but could not enroll it as input (${failures[0].op}: ${failures[0].error.type}).`);

    console.log(`Added ${accession} to analysis "${analysis.name}" — ${downloaded.value.length} file(s) under ${destDir}.`);
    console.log("The files are enrolled as inputs; they will be staged and profiled when the analysis is next active.");
}
