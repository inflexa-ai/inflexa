import { Hono } from "hono";
import { z } from "zod";

import type { DeleteProjectResponse, ProjectSummary, ProjectView } from "../../api/projects.ts";
import { createProject, deleteProject } from "../../db/primary_mutation.ts";
import { listProjectPage } from "../../db/primary_query.ts";
import { str256 } from "../../lib/types.ts";
import type { Project } from "../../types/project.ts";
import { apiError, internalError, listEnvelope, parsePage, readBody, type ServerEnv } from "../http.ts";

/** The body of `POST /api/v1/projects`. The db stores the tags comma-joined, thus a tag with a comma is refused here. */
const createProjectBody = z.object({
    name: z.string(),
    description: z.string().optional(),
    tags: z.array(z.string().refine((tag) => !tag.includes(","), "A tag must not hold a comma.")).optional(),
});

/** The routes under `/api/v1/projects` (draft 2.2). They read and write SQLite only, thus they need no runtime. */
export function projectRoutes(): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.get("/", (c) => {
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        return listProjectPage({ limit: page.perPage, offset: page.page * page.perPage }).match(
            ({ items, total }) =>
                c.json(
                    listEnvelope(
                        "projects",
                        items.map((item): ProjectSummary => ({ ...toProjectView(item.project), analysisCount: item.analysisCount })),
                        total,
                        page,
                    ),
                ),
            (e) => internalError(c, e, "list the projects"),
        );
    });

    routes.post("/", async (c) => {
        const body = await readBody(c, createProjectBody);
        if (body.isErr()) return body.error;
        const name = str256(body.value.name);
        if (name.isErr()) {
            const reason = name.error === "empty" ? "must not be blank" : "must be at most 256 characters";
            return apiError(c, "validation_error", `Invalid project name: ${reason}.`, { fieldErrors: { name: [reason] } });
        }
        const tags = (body.value.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
        return createProject({ name: name.value, description: body.value.description ?? null, tags }).match(
            (project) => c.json(toProjectView(project), 201),
            (e) =>
                e.type === "constraint_violation" && e.constraint === "unique"
                    ? apiError(c, "conflict", `A project named "${name.value}" already exists.`)
                    : internalError(c, e, "create a project"),
        );
    });

    // The analyses of the project stay. Each one loses its project, in the same transaction as the delete.
    routes.delete("/:projectId", (c) => {
        const projectId = c.req.param("projectId");
        return deleteProject(projectId).match(
            (changed) => (changed === 0 ? apiError(c, "not_found", "Project not found.") : c.json({ deleted: true } satisfies DeleteProjectResponse)),
            (e) => internalError(c, e, "delete a project"),
        );
    });

    return routes;
}

/** The wire form of a project row. */
export function toProjectView(project: Project): ProjectView {
    return {
        id: project.id,
        createdAt: new Date(project.createdAt).toISOString(),
        updatedAt: new Date(project.updatedAt).toISOString(),
        name: project.name,
        description: project.description,
        tags: project.tags,
    };
}
