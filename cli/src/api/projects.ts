import type { ListEnvelope } from "./common.ts";

/** A project on the wire. Timestamps are ISO 8601. */
export type ProjectView = {
    id: string;
    createdAt: string;
    updatedAt: string;
    /** Unique over all projects. */
    name: string;
    description: string | null;
    tags: string[];
};

/** A project of the list, with the count of the analyses under it. */
export type ProjectSummary = ProjectView & {
    analysisCount: number;
};

/** The body of `POST /api/v1/projects`. The server trims the name and each tag, and drops a blank tag. A tag must not hold a comma. */
export type CreateProjectRequest = {
    name: string;
    description?: string;
    tags?: string[];
};

/** The body of `GET /api/v1/projects`: newest first. */
export type ProjectList = ListEnvelope<"projects", ProjectSummary>;

/** The body of a `DELETE /api/v1/projects/:projectId` response. */
export type DeleteProjectResponse = {
    deleted: true;
};
