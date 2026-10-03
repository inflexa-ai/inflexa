import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";

import type { ApiError } from "../../api/common.ts";
import type { ProjectList, ProjectView } from "../../api/projects.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { getAnalysis } from "../../db/primary_query.ts";
import { asStr256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import { projectRoutes } from "./projects.ts";

// The routes alone, with no app and no bearer check: `app.test.ts` covers those. Each `as` cast of a body
// below reads JSON that the route under test builds from the same `src/api/` type.
const routes = projectRoutes();

function post(body: unknown): Promise<Response> {
    return Promise.resolve(routes.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

beforeEach(() => {
    freshDb();
});

describe("POST /api/v1/projects", () => {
    test("201 with the project; the name and each tag are trimmed, and a blank tag is dropped", async () => {
        const response = await post({ name: "  Acme ", description: "liver work", tags: [" rna ", "", "liver"] });
        expect(response.status).toBe(201);
        const project = (await response.json()) as ProjectView;
        expect(project).toMatchObject({ name: "Acme", description: "liver work", tags: ["rna", "liver"] });
        expect(new Date(project.createdAt).toISOString()).toBe(project.createdAt);
    });

    test("409 `conflict` for a taken name", async () => {
        expect((await post({ name: "Acme" })).status).toBe(201);
        const response = await post({ name: "Acme" });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "conflict", message: 'A project named "Acme" already exists.' });
    });

    test("400 `validation_error` for a blank name, a missing name, or a tag with a comma", async () => {
        const blank = await post({ name: "   " });
        expect(blank.status).toBe(400);
        expect(await blank.json()).toMatchObject({ error: "validation_error", message: "Invalid project name: must not be blank." });

        for (const body of [{}, { name: "x", tags: ["a,b"] }]) {
            const response = await post(body);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ error: "validation_error", details: { fieldErrors: expect.any(Object) } });
        }
    });

    test("400 `invalid_json` for a body that is not JSON", async () => {
        const response = await routes.request("/", { method: "POST", body: "{not json" });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_json" });
    });
});

describe("GET /api/v1/projects", () => {
    test("pages the projects newest first, each with its analysis count", async () => {
        const create = async (name: string): Promise<ProjectView> => (await (await post({ name })).json()) as ProjectView;
        await create("first");
        await create("second");
        const third = await create("third");
        const now = Date.now();
        const anchorId = randomUUIDv7();
        insertAnchor({ id: anchorId, createdAt: now, updatedAt: now, cachedPath: "/tmp/a", markerWritten: false, lastSeen: now })._unsafeUnwrap();
        insertAnalysis({ id: randomUUIDv7(), createdAt: now, updatedAt: now, name: asStr256("a"), slug: "a", anchorId, projectId: third.id })._unsafeUnwrap();

        const first = (await (await routes.request("/?perPage=2")).json()) as ProjectList;
        expect(first.projects.map((p) => [p.name, p.analysisCount])).toEqual([
            ["third", 1],
            ["second", 0],
        ]);
        expect(first).toMatchObject({ total: 3, page: 0, perPage: 2, hasMore: true });

        const second = (await (await routes.request("/?page=1&perPage=2")).json()) as ProjectList;
        expect(second.projects.map((p) => p.name)).toEqual(["first"]);
        expect(second.hasMore).toBe(false);
    });
});

describe("DELETE /api/v1/projects/:projectId", () => {
    test("removes the project, keeps its analyses with no project, and 404 for an unknown id", async () => {
        const project = (await (await post({ name: "Liver" })).json()) as ProjectView;
        const now = Date.now();
        const anchorId = randomUUIDv7();
        const analysisId = randomUUIDv7();
        insertAnchor({ id: anchorId, createdAt: now, updatedAt: now, cachedPath: "/tmp/a", markerWritten: false, lastSeen: now })._unsafeUnwrap();
        insertAnalysis({ id: analysisId, createdAt: now, updatedAt: now, name: asStr256("a"), slug: "a", anchorId, projectId: project.id })._unsafeUnwrap();

        const deleted = await routes.request(`/${project.id}`, { method: "DELETE" });
        expect(deleted.status).toBe(200);
        expect(await deleted.json()).toEqual({ deleted: true });
        expect(getAnalysis(analysisId)._unsafeUnwrap()?.projectId).toBeNull();

        const again = await routes.request(`/${project.id}`, { method: "DELETE" });
        expect(again.status).toBe(404);
        expect(((await again.json()) as ApiError).error).toBe("not_found");
    });
});
