import { validatePath } from "@inflexa-ai/harness/tools/lib/path-validation";
import { Hono } from "hono";
import { z } from "zod";

import type { ArtifactError, ResolvedArtifact, ResolvedArtifacts } from "../../api/artifacts.ts";
import { getLogger } from "../../lib/log.ts";
import { entryDegraded, materializeTarget, resolveEntryPath, type OpenArtifactError } from "../../modules/harness/artifact_open.ts";
import type { OpenTarget } from "../../types/session.ts";
import { readBody, type ServerEnv } from "../http.ts";

/** The harness mints each presentation id as `pres-` and a hex digest. The id names a file in the workspace, thus nothing else passes. */
const presId = z.string().regex(/^pres-[A-Za-z0-9_-]+$/, "A presentation id is `pres-` and a digest.");

const openTarget = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("workspace-file"), path: z.string() }),
    z.object({ kind: z.literal("echart"), presId, spec: z.record(z.string(), z.unknown()), dataPath: z.string().optional() }),
    z.object({ kind: z.literal("svg"), presId, markup: z.string() }),
    z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);

const resolveBody = z.object({
    entries: z.array(openTarget).max(1000),
    materialize: z.boolean(),
});

/**
 * The route `POST {A}/artifacts/resolve` (draft 2.5): the path on disk and the degraded mark of each
 * openable entry of a card. With `materialize`, it first writes the echart or svg file of each entry into
 * the `presentations/` folder of the workspace. The client opens the path, because the desktop opener runs
 * on the machine of the client. It reads SQLite and the disk only, thus it needs no runtime.
 */
export function artifactRoutes(): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.post("/resolve", async (c) => {
        const body = await readBody(c, resolveBody);
        if (body.isErr()) return body.error;
        const analysisId = c.req.param("analysisId") ?? "";
        const entries = body.value.entries.map((target) => resolveArtifact(analysisId, target, body.value.materialize));
        return c.json({ entries } satisfies ResolvedArtifacts);
    });

    return routes;
}

function resolveArtifact(analysisId: string, target: OpenTarget, materialize: boolean): ResolvedArtifact {
    // A card reference is analysis-rooted. A stored part that reloads from a persisted tool call skips the
    // validation of the live tool, thus a path that leaves the workspace degrades here and resolves nowhere.
    if (target.kind === "workspace-file" && validatePath(target.path) !== null) {
        return {
            kind: target.kind,
            path: null,
            degraded: true,
            ...(materialize ? { error: { type: "unavailable", reason: "the path is not inside the analysis" } } : {}),
        };
    }
    const path = resolveEntryPath(analysisId, target);
    const degraded = entryDegraded(analysisId, target);
    if (!materialize) return { kind: target.kind, path, degraded };
    return materializeTarget(analysisId, target).match(
        (ready): ResolvedArtifact => ({ kind: target.kind, path: ready, degraded }),
        (e): ResolvedArtifact => ({ kind: target.kind, path, degraded, error: toArtifactError(e) }),
    );
}

function toArtifactError(e: OpenArtifactError): ArtifactError {
    switch (e.type) {
        case "unresolved":
            return { type: "unresolved" };
        case "missing":
            return { type: "missing", path: e.path };
        case "materialize_failed":
            getLogger("server").error({ err: e.cause }, "could not write a presentation file");
            return { type: "materialize_failed" };
        case "unavailable":
            return { type: "unavailable", reason: e.reason };
        default: {
            const exhaustive: never = e;
            throw new Error(`unhandled artifact error: ${JSON.stringify(exhaustive)}`);
        }
    }
}
