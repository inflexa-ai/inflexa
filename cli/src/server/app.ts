import { timingSafeEqual } from "node:crypto";

import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import { getLogger } from "../lib/log.ts";
import type { ServerBoot } from "./boot.ts";
import { createBrowserSessionStore, SIGN_IN_AGAIN_MESSAGE, SIGN_IN_PATH, sessionCookieName, type BrowserSessionStore } from "./browser_session.ts";
import { apiError, listenerPort, type ServerEnv } from "./http.ts";
import type { ServerLifecycle } from "./lifecycle.ts";
import { analysisGuard } from "./analysis_guard.ts";
import { analysisCollectionRoutes, analysisRoutes } from "./routes/analyses.ts";
import { anchorRoutes } from "./routes/anchors.ts";
import { artifactRoutes } from "./routes/artifacts.ts";
import { browserSessionRoutes } from "./routes/browser_session.ts";
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

/** The clock of the browser sign-in store in {@link buildApp}. A test replaces it to move the time. */
export type AppOpts = {
    readonly now: () => number;
};

/** The production {@link AppOpts}. */
export const DEFAULT_APP_OPTS: AppOpts = { now: Date.now };

/**
 * The HTTP app of the local server: the Host and Origin check on each path, the credential check on each `/api/`
 * path, the routes of each domain, and the error bodies for an unknown path and for a handler that throws. It
 * binds no port, thus a test drives it with `app.request()`.
 */
export function buildApp(deps: AppDeps, opts: AppOpts = DEFAULT_APP_OPTS): Hono<ServerEnv> {
    const app = new Hono<ServerEnv>();
    app.use("*", hostOriginGuard());
    const sessions = createBrowserSessionStore(opts.now);
    app.use("/api/*", credentialAuth(deps.token, sessions));
    app.route(SIGN_IN_PATH, browserSessionRoutes(sessions));
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
    app.get("/gui", (c) => c.redirect("/gui/", 301));
    app.route("/gui/", guiRoutes());
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
        const port = listenerPort(c);
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

/**
 * 401 `unauthorized` unless the request proves a credential, and it sets `credential` for the handler:
 *
 *   1. `GET /api/v1/session` passes, because its handler checks the nonce. The match is exact on the method and on
 *      the path, which holds no query.
 *   2. A valid `Authorization: Bearer <token>` passes as `bearer`.
 *   3. A session cookie of this server passes as `cookie`. The cookie counts only when `Sec-Fetch-Site` is absent,
 *      `same-origin`, or `none`: `SameSite=Strict` treats `127.0.0.1:<other port>` as the same site, and a page of
 *      another local server can send the cookie in an `<img>` request that carries no `Origin` header.
 *
 * A cookie that names no session gets the message that tells the person to sign in again.
 */
function credentialAuth(token: string, sessions: BrowserSessionStore): MiddlewareHandler<ServerEnv> {
    const expected = Buffer.from(token);
    return async (c, next) => {
        if (c.req.method === "GET" && c.req.path === SIGN_IN_PATH) {
            await next();
            return;
        }
        const header = c.req.header("Authorization") ?? "";
        const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "");
        // `timingSafeEqual` throws when the lengths differ, thus the length test comes first. The length of
        // the token is public: each token is 64 hex characters.
        if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
            c.set("credential", "bearer");
            await next();
            return;
        }
        const site = c.req.header("Sec-Fetch-Site");
        let unknownSession = false;
        if (site === undefined || site === "same-origin" || site === "none") {
            const secret = getCookie(c, sessionCookieName(listenerPort(c)));
            if (secret !== undefined) {
                if (sessions.hasSession(secret)) {
                    c.set("credential", "cookie");
                    await next();
                    return;
                }
                unknownSession = true;
            }
        }
        return apiError(
            c,
            "unauthorized",
            unknownSession ? SIGN_IN_AGAIN_MESSAGE : "Send the token of the server discovery file as `Authorization: Bearer <token>`.",
        );
    };
}
