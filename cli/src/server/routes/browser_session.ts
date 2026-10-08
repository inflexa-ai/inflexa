import { Hono } from "hono";
import { setCookie } from "hono/cookie";

import type { SessionNonce } from "../../api/browser_session.ts";
import { SIGN_IN_AGAIN_MESSAGE, sessionCookieName, type BrowserSessionStore } from "../browser_session.ts";
import { apiError, listenerPort, type ServerEnv } from "../http.ts";

/** Where the sign-in goes when the link names no `next`. */
const DEFAULT_NEXT = "/gui/";

/**
 * A path of the server origin: it starts with `/`, its second character is not `/`, and it holds only the printable
 * ASCII characters from `!` to `~`, without `\`. A browser removes a tab or a newline from a URL, thus
 * `/%09/evil.example` would become `//evil.example`. A CR or an LF would make the `Location` header fail after the
 * nonce is used.
 */
const NEXT_PATH = /^\/(?!\/)[!-~]*$/;

function isServerPath(next: string): boolean {
    return NEXT_PATH.test(next) && !next.includes("\\");
}

/**
 * The browser sign-in routes under `/api/v1/session`. `POST /nonce` gives a nonce to the bearer token. `GET /`
 * needs no credential: it uses the nonce, sets the session cookie, and redirects to `next`.
 */
export function browserSessionRoutes(sessions: BrowserSessionStore): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.post("/nonce", (c) => {
        // A session cookie must not make a new credential for itself.
        if (c.get("credential") === "cookie") {
            return apiError(c, "forbidden", "Only the bearer token of the server discovery file gets a sign-in nonce.");
        }
        const issued = sessions.issueNonce();
        return c.json<SessionNonce>({ nonce: issued.nonce, expiresAt: new Date(issued.expiresAtMs).toISOString() }, 201);
    });

    routes.get("/", (c) => {
        // `next` comes first, so a bad `next` leaves the nonce usable.
        const next = c.req.query("next") ?? DEFAULT_NEXT;
        if (!isServerPath(next)) {
            return apiError(
                c,
                "validation_error",
                "`next` must be a path of this server: it starts with a single `/` and holds only printable ASCII characters, without `\\`.",
            );
        }
        if (!sessions.consumeNonce(c.req.query("nonce") ?? "")) {
            return apiError(c, "unauthorized", SIGN_IN_AGAIN_MESSAGE);
        }
        setCookie(c, sessionCookieName(listenerPort(c)), sessions.openSession(), { httpOnly: true, sameSite: "Strict", path: "/api" });
        c.header("Cache-Control", "no-store");
        return c.redirect(next, 303);
    });

    return routes;
}
