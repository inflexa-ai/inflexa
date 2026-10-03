import type { ResultAsync } from "neverthrow";

import type { PageQuery } from "../api/common.ts";
import type { CreateProjectRequest, DeleteProjectResponse, ProjectList, ProjectView } from "../api/projects.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/** `GET /api/v1/projects`: one page of the projects, newest first, each with its analysis count. */
export function fetchProjects(page: PageQuery, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ProjectList, ClientError> {
    return request<ProjectList>("GET", `/api/v1/projects?page=${page.page}&perPage=${page.perPage}`, {}, opts);
}

/** `POST /api/v1/projects`: make a project. 409 `conflict` for a taken name, 400 `validation_error` for a blank or long name. */
export function createProject(body: CreateProjectRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ProjectView, ClientError> {
    return request<ProjectView>("POST", "/api/v1/projects", { body }, opts);
}

/** `DELETE /api/v1/projects/:projectId`: remove a project. Its analyses stay, with no project. 404 `not_found` for an unknown id. */
export function deleteProject(projectId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<DeleteProjectResponse, ClientError> {
    return request<DeleteProjectResponse>("DELETE", `/api/v1/projects/${encodeURIComponent(projectId)}`, {}, opts);
}
