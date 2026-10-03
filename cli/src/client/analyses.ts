import type { ResultAsync } from "neverthrow";

import type {
    AnalysisDetail,
    AnalysisList,
    AnalysisView,
    CreateAnalysisRequest,
    DeleteAnalysisResponse,
    DeleteExportFormat,
    InputList,
    InputsChange,
    OutputDirView,
    ResolveAnalysisRequest,
    ResolvedContextView,
    UpdateAnalysisRequest,
    UpdateAnalysisResponse,
    WorkspaceDisposalMode,
} from "../api/analyses.ts";
import type { PageQuery } from "../api/common.ts";
import { asStr256 } from "../lib/types.ts";
import type { Analysis } from "../types/analysis.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/**
 * The domain form of an analysis of the wire, which the TUI scope holds. The timestamps go back to epoch
 * milliseconds.
 */
export function toAnalysis(view: AnalysisView): Analysis {
    return {
        id: view.id,
        createdAt: Date.parse(view.createdAt),
        updatedAt: Date.parse(view.updatedAt),
        // The server validated the name through `str256` before it stored it.
        name: asStr256(view.name),
        slug: view.slug,
        anchorId: view.anchorId,
        projectId: view.projectId,
    };
}

/**
 * The working folder of a chat on an analysis: the live anchor folder, else its last known path, else the
 * folder of this process when the anchor row is gone.
 */
export function workingDirOf(detail: AnalysisDetail): string {
    return detail.anchor?.path ?? detail.anchor?.cachedPath ?? process.cwd();
}

/** The path of one analysis, with its id escaped for the path. */
function analysisPath(analysisId: string): string {
    return `/api/v1/analyses/${encodeURIComponent(analysisId)}`;
}

/** `POST /api/v1/analyses/resolve`: what a folder or a reference resolves to. */
export function resolveAnalysisContext(body: ResolveAnalysisRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ResolvedContextView, ClientError> {
    return request<ResolvedContextView>("POST", "/api/v1/analyses/resolve", { body }, opts);
}

/** `GET /api/v1/analyses`: one page of the analyses, newest first. `project` narrows to one project, by id or by name. */
export function fetchAnalyses(page: PageQuery & { project?: string }, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AnalysisList, ClientError> {
    const project = page.project === undefined ? "" : `&project=${encodeURIComponent(page.project)}`;
    return request<AnalysisList>("GET", `/api/v1/analyses?page=${page.page}&perPage=${page.perPage}${project}`, {}, opts);
}

/** `POST /api/v1/analyses`: make an analysis anchored at `folder`. */
export function createAnalysis(body: CreateAnalysisRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AnalysisDetail, ClientError> {
    return request<AnalysisDetail>("POST", "/api/v1/analyses", { body }, opts);
}

/** `GET {A}`: one analysis with its scope. The first request for an analysis takes its instance lock (409 `locked`). */
export function fetchAnalysis(analysisId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AnalysisDetail, ClientError> {
    return request<AnalysisDetail>("GET", analysisPath(analysisId), {}, opts);
}

/** `PATCH {A}`: rename the analysis, or set or clear its project. A rename gives 409 `busy` while work holds the folder. */
export function updateAnalysis(
    analysisId: string,
    body: UpdateAnalysisRequest,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<UpdateAnalysisResponse, ClientError> {
    return request<UpdateAnalysisResponse>("PATCH", analysisPath(analysisId), { body }, opts);
}

/** `DELETE {A}`: the ordered delete of the analysis. 409 `busy` while work holds the folder. */
export function deleteAnalysis(
    analysisId: string,
    query: { workspace: WorkspaceDisposalMode; export: DeleteExportFormat },
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<DeleteAnalysisResponse, ClientError> {
    return request<DeleteAnalysisResponse>("DELETE", `${analysisPath(analysisId)}?workspace=${query.workspace}&export=${query.export}`, {}, opts);
}

/** `POST {A}/output-dir`: make sure that the workspace folder exists, and give its path. The client opens it. */
export function createOutputDir(analysisId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<OutputDirView, ClientError> {
    return request<OutputDirView>("POST", `${analysisPath(analysisId)}/output-dir`, {}, opts);
}

/** `GET {A}/inputs`: one page of the inputs of the analysis. */
export function fetchInputs(analysisId: string, page: PageQuery, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<InputList, ClientError> {
    return request<InputList>("GET", `${analysisPath(analysisId)}/inputs?page=${page.page}&perPage=${page.perPage}`, {}, opts);
}

/** `PUT {A}/inputs`: replace the input set with `paths`, each one absolute. */
export function replaceInputs(analysisId: string, paths: string[], opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<InputsChange, ClientError> {
    return request<InputsChange>("PUT", `${analysisPath(analysisId)}/inputs`, { body: { paths } }, opts);
}

/** `POST {A}/inputs`: add `paths`, each one absolute. 400 `validation_error` names each path that does not exist. */
export function addInputs(analysisId: string, paths: string[], opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<InputsChange, ClientError> {
    return request<InputsChange>("POST", `${analysisPath(analysisId)}/inputs`, { body: { paths } }, opts);
}

/** `POST {A}/inputs/remove`: remove the inputs at `paths`, each one absolute or the stored path of an input. */
export function removeInputs(analysisId: string, paths: string[], opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<InputsChange, ClientError> {
    return request<InputsChange>("POST", `${analysisPath(analysisId)}/inputs/remove`, { body: { paths } }, opts);
}
