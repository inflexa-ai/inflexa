import type { ResultAsync } from "neverthrow";

import type { ExportProvenanceRequest, ExportProvenanceResult, LineageView } from "../api/provenance.ts";
import type { VerifyResult } from "../types/prov.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/** The path of the provenance routes of one analysis. */
function provenancePath(analysisId: string, tail: string): string {
    return `/api/v1/analyses/${encodeURIComponent(analysisId)}/provenance/${tail}`;
}

/**
 * `POST {A}/provenance/export`: flush the recorder, then write the export, and the signed attestation beside a
 * PROV-JSON export. 409 `conflict` when the output folder of the analysis is not available.
 */
export function createProvenanceExport(
    analysisId: string,
    body: ExportProvenanceRequest,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<ExportProvenanceResult, ClientError> {
    return request<ExportProvenanceResult>("POST", provenancePath(analysisId, "export"), { body }, opts);
}

/** `GET {A}/provenance/verify`: the check of the signed chain that the database holds. */
export function fetchProvenanceVerification(analysisId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<VerifyResult, ClientError> {
    return request<VerifyResult>("GET", provenancePath(analysisId, "verify"), {}, opts);
}

/**
 * What `GET {A}/provenance/lineage` walks: the record to trace, the direction, the hop bound, and the
 * format. `depth` and `format` go as the person typed them, because the server validates them.
 */
export type LineageQuery = {
    ref: string;
    forward?: boolean;
    depth?: string;
    /** `tree`, `json`, `dot`, or `mermaid` when it is valid. */
    format?: string;
};

/**
 * `GET {A}/provenance/lineage`: flush the recorder, then walk the lineage of `ref`. 404 `not_found` when no
 * record matches or no provenance is recorded, 409 `conflict` for an ambiguous ref, 400 `validation_error` for
 * a bad format or depth.
 */
export function fetchLineage(analysisId: string, query: LineageQuery, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<LineageView, ClientError> {
    const params = new URLSearchParams({ ref: query.ref });
    if (query.forward === true) params.set("forward", "true");
    if (query.depth !== undefined) params.set("depth", query.depth);
    if (query.format !== undefined) params.set("format", query.format);
    return request<LineageView>("GET", `${provenancePath(analysisId, "lineage")}?${params.toString()}`, {}, opts);
}
