import { isAbsolute } from "node:path";

import { Hono, type Context } from "hono";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { z } from "zod";

import type { ExportProvenanceResult, LineageFormat } from "../../api/provenance.ts";
import { getAnalysis } from "../../db/primary_query.ts";
import { getLogger } from "../../lib/log.ts";
import { exportAnalysisProvenance } from "../../modules/prov/export.ts";
import { walkAnalysisLineage } from "../../modules/prov/lineage.ts";
import { flushProvenanceAsync } from "../../modules/prov/prov.ts";
import { verifyAnalysisIntegrity } from "../../modules/prov/verify.ts";
import type { Analysis } from "../../types/analysis.ts";
import { apiError, internalError, readBody, type ServerEnv } from "../http.ts";

const exportBody = z.object({
    format: z.enum(["prov-json", "prov-n"]),
    output: z.string().refine(isAbsolute, "The output path must be absolute.").optional(),
});

const LINEAGE_FORMATS = ["tree", "json", "dot", "mermaid"] as const satisfies readonly LineageFormat[];

/**
 * The routes under `{A}/provenance` (draft 2.5). They read the signed chain from SQLite and the signing
 * key from disk, thus they need no runtime. The export and the lineage flush the recorder first, thus they
 * include the appends that this process holds in memory.
 */
export function provenanceRoutes(): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.post("/export", async (c) => {
        const body = await readBody(c, exportBody);
        if (body.isErr()) return body.error;
        const analysis = analysisOf(c);
        if (analysis.isErr()) return analysis.error;
        await flushRecorder();
        const format = body.value.format === "prov-json" ? "json" : "provn";
        const exported = await exportAnalysisProvenance(analysis.value, format, body.value.output);
        return exported.match(
            (v) =>
                c.json({ path: v.path, ...(v.attestationPath === undefined ? {} : { attestationPath: v.attestationPath }) } satisfies ExportProvenanceResult),
            (e) => {
                switch (e.type) {
                    case "output_dir":
                        return e.error.type === "workspace_unavailable"
                            ? apiError(c, "conflict", `The output folder is not available: ${e.error.message}`)
                            : internalError(c, e.error, "resolve the output folder");
                    // A 500 with the signing failure named, not the generic text: the person must know that
                    // nothing was written, because provenance is never exported unsigned.
                    case "signing":
                        getLogger("server").error({ err: e.error }, "could not sign a provenance export");
                        return apiError(c, "internal_error", `Signing failed (${e.error.type}) — provenance is never exported unsigned.`);
                    case "serialize":
                        return internalError(c, e.error, "build the provenance document");
                    case "write":
                        return internalError(c, e.cause, `write the provenance to ${e.path}`);
                    case "attestation_write":
                        return internalError(c, e.cause, `write the attestation beside ${e.path}`);
                    default: {
                        const exhaustive: never = e;
                        throw new Error(`unhandled export error: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
        );
    });

    routes.get("/verify", async (c) => {
        const analysis = analysisOf(c);
        if (analysis.isErr()) return analysis.error;
        // `null` is the miss of the analysis row, which the lookup above excludes, or a failed read of the
        // integrity columns, which `verifyAnalysisIntegrity` logs.
        const result = await verifyAnalysisIntegrity(analysis.value.id);
        return result === null ? apiError(c, "internal_error", "Could not read the provenance of the analysis.") : c.json(result);
    });

    routes.get("/lineage", async (c) => {
        const ref = c.req.query("ref");
        if (ref === undefined || ref === "")
            return apiError(c, "validation_error", "Send the record to trace as `ref`.", { fieldErrors: { ref: ["required"] } });
        const format = (c.req.query("format") ?? "tree").toLowerCase();
        if (!isLineageFormat(format))
            return apiError(c, "validation_error", `Unknown format "${c.req.query("format")}". Use "tree", "json", "dot", or "mermaid".`);
        const rawDepth = c.req.query("depth");
        const depth = rawDepth === undefined ? undefined : Number(rawDepth);
        if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) {
            return apiError(c, "validation_error", `\`depth\` must be a positive integer, got "${rawDepth}".`);
        }
        const forward = c.req.query("forward") === "true";

        const analysis = analysisOf(c);
        if (analysis.isErr()) return analysis.error;
        await flushRecorder();
        return walkAnalysisLineage(analysis.value, ref, { forward, format, ...(depth === undefined ? {} : { depth }) }).match(
            (view) => c.json(view),
            (e) => {
                switch (e.type) {
                    case "no_provenance":
                        return apiError(c, "not_found", e.message);
                    case "ref":
                        return e.error.type === "not_found"
                            ? apiError(c, "not_found", e.message, { knownPaths: e.error.knownPaths })
                            : apiError(c, "conflict", e.message, { candidates: e.error.candidates });
                    case "corrupt":
                        return internalError(c, e.cause, "read the stored provenance");
                    case "storage":
                        return internalError(c, e.cause, "read the stored provenance");
                    default: {
                        const exhaustive: never = e;
                        throw new Error(`unhandled lineage error: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
        );
    });

    return routes;
}

/** A type predicate over a query value: sound because it tests membership in the closed list of formats. */
function isLineageFormat(value: string): value is LineageFormat {
    return (LINEAGE_FORMATS as readonly string[]).includes(value);
}

/** The analysis row of the path. The error channel holds the response to send. The guard of `{A}` already gives 404 for an unknown id. */
function analysisOf(c: Context): Result<Analysis, Response> {
    const analysisId = c.req.param("analysisId") ?? "";
    return getAnalysis(analysisId)
        .mapErr((e) => internalError(c, e, "read the analysis"))
        .andThen((analysis) => (analysis === null ? err(apiError(c, "not_found", `No analysis has the id ${analysisId}.`)) : ok(analysis)));
}

/**
 * Drain the in-memory appends of the recorder into the signed column. A flush that fails leaves the
 * stored chain as it was, thus the read continues on it: it then misses only the newest appends.
 */
async function flushRecorder(): Promise<void> {
    (await ResultAsync.fromPromise(flushProvenanceAsync(), (cause) => cause)).match(
        () => undefined,
        (cause) => getLogger("server").warn({ err: cause }, "the provenance flush before a read failed"),
    );
}
