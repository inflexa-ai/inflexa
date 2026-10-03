import { timingSafeEqual } from "node:crypto";

import { Hono, type MiddlewareHandler } from "hono";

import { devCommandsEnabled } from "../lib/env.ts";
import { getLogger } from "../lib/log.ts";
import type { ServerBoot } from "./boot.ts";
import { apiError, type ServerEnv } from "./http.ts";
import type { ServerLifecycle } from "./lifecycle.ts";
import { analysisGuard } from "./analysis_guard.ts";
import { analysisCollectionRoutes, analysisRoutes } from "./routes/analyses.ts";
import { anchorRoutes } from "./routes/anchors.ts";
import { artifactRoutes } from "./routes/artifacts.ts";
import { conversationRoutes } from "./routes/conversation.ts";
import { guiRoutes } from "./routes/gui.ts";
import { machineRoutes } from "./routes/machine.ts";
import { projectRoutes } from "./routes/projects.ts";
import { provenanceRoutes } from "./routes/provenance.ts";
import { runRoutes } from "./routes/runs.ts";
import { serverRoutes } from "./routes/server.ts";
import { farmLinkRoutes, storeRoutes } from "./routes/store.ts";
import { usageRoutes } from "./routes/usage.ts";

/** What the HTTP app of the server is built from. */
export type AppDeps = {
    /** The bearer token that each request under `/api/` must send. */
    readonly token: string;
    readonly boot: ServerBoot;
    readonly lifecycle: ServerLifecycle;
};

/** The build channel decision of {@link buildApp}. Tests replace it. */
export type AppOpts = {
    /** True when the app serves the proof-of-concept web GUI at `/gui/`. */
    readonly guiEnabled: () => boolean;
};

/** The production {@link AppOpts}: the web GUI is a surface of the dev channel only. */
export const DEFAULT_APP_OPTS: AppOpts = { guiEnabled: devCommandsEnabled };

/**
 * The HTTP app of the local server: the Host and Origin check on each path, the bearer check on each `/api/`
 * path, the routes of each domain, and the error bodies for an unknown path and for a handler that throws. It
 * binds no port, thus a test drives it with `app.request()`.
 */
export function buildApp(deps: AppDeps, opts: AppOpts = DEFAULT_APP_OPTS): Hono<ServerEnv> {
    const app = new Hono<ServerEnv>();
    app.use("*", hostOriginGuard());
    app.use("/api/*", bearerAuth(deps.token));
    app.route("/api/v1/server", serverRoutes(deps.boot, deps.lifecycle));
    app.route("/api/v1/projects", projectRoutes());
    app.route("/api/v1", machineRoutes());
    app.route("/api/v1", storeRoutes());
    app.route("/api/v1/anchors", anchorRoutes(deps.boot));
    app.route("/api/v1/analyses", analysisCollectionRoutes());
    // The guard of each `{A}` route: 404 for an unknown analysis, then its instance lock. Each route under
    // `/api/v1/analyses/:analysisId` mounts AFTER this line, or it answers before the guard runs.
    app.use("/api/v1/analyses/:analysisId/*", analysisGuard());
    app.route("/api/v1/analyses/:analysisId", analysisRoutes(deps.boot));
    app.route("/api/v1/analyses", conversationRoutes(deps.boot));
    app.route("/api/v1/analyses/:analysisId/usage", usageRoutes());
    app.route("/api/v1/analyses/:analysisId/provenance", provenanceRoutes());
    app.route("/api/v1/analyses/:analysisId/artifacts", artifactRoutes());
    app.route("/api/v1/analyses/:analysisId", runRoutes(deps.boot));
    app.route("/api/v1/analyses/:analysisId", farmLinkRoutes());
    if (opts.guiEnabled()) {
        // A browser keeps the `#token=` fragment of the page URL across the redirect.
        app.get("/gui", (c) => c.redirect("/gui/", 301));
        app.route("/gui/", guiRoutes());
    }
    app.notFound((c) => apiError(c, "not_found", `No route for ${c.req.method} ${c.req.path}.`));
    // A handler gives its failures as error bodies. This is the net for a throw past that, for example from
    // a harness call, and it keeps the internal cause out of the response.
    app.onError((cause, c) => {
        getLogger("server").error({ err: cause, method: c.req.method, path: c.req.path }, "a route failed");
        return apiError(c, "internal_error", "The server failed to handle the request.");
    });
    return app;
}

/**
 * 403 `forbidden` unless the request names this server. The `Host` header must be `127.0.0.1:<port>` or
 * `localhost:<port>`, and an `Origin` header must be `http://` with one of the two, or absent. This stops a DNS
 * rebind: a page whose host name now points at 127.0.0.1 still sends its own host name, and its own origin on a
 * POST. A page cannot change the two headers.
 *
 * The port is the port that the listener bound. A request with no Bun server is an in-process `app.request()`
 * of a test. No socket carried it, thus no browser sent it, and it passes.
 */
function hostOriginGuard(): MiddlewareHandler<ServerEnv> {
    return async (c, next) => {
        // `listen` in serve.ts gives `app.fetch` to `Bun.serve`, which passes its server as the second argument of
        // `fetch`. Hono gives that argument as `c.env`.
        const port = (c.env as { port?: number } | undefined)?.port;
        if (port !== undefined) {
            const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
            const host = c.req.header("Host")?.toLowerCase();
            if (host === undefined || !hosts.includes(host)) {
                return apiError(c, "forbidden", `The Host header must be ${hosts.join(" or ")}. The server answers only a request to its own address.`);
            }
            const origin = c.req.header("Origin")?.toLowerCase();
            if (origin !== undefined && !hosts.some((name) => origin === `http://${name}`)) {
                return apiError(
                    c,
                    "forbidden",
                    `The Origin header must be http://${hosts.join(" or http://")}, or absent. The server answers no page of a different origin.`,
                );
            }
        }
        await next();
    };
}

/** 401 `unauthorized` unless the request sends `Authorization: Bearer <token>`. */
function bearerAuth(token: string): MiddlewareHandler<ServerEnv> {
    const expected = Buffer.from(token);
    return async (c, next) => {
        const header = c.req.header("Authorization") ?? "";
        const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "");
        // `timingSafeEqual` throws when the lengths differ, thus the length test comes first. The length of
        // the token is public: each token is 64 hex characters.
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
            return apiError(c, "unauthorized", "Send the token of the server discovery file as `Authorization: Bearer <token>`.");
        }
        await next();
    };
}
