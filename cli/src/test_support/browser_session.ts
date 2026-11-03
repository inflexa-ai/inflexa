import type { Hono } from "hono";

import { z } from "zod";

import type { ServerEnv } from "../server/http.ts";
import { jsonBody } from "./response_body.ts";

const nonceSchema = z.looseObject({ nonce: z.string() });

/**
 * Sign a browser in to `app`, the way `inflexa gui` does: a nonce for the bearer token, then the sign-in link. It
 * gives the `Cookie` header value that the browser then sends. `listener` is the `c.env` of a request that a
 * socket carried, and it picks the port in the cookie name.
 */
export async function signIn(app: Hono<ServerEnv>, token: string, listener?: { port: number }): Promise<string> {
    // A request that a socket carried must name the server in its `Host` header.
    const host: Record<string, string> = listener === undefined ? {} : { Host: `127.0.0.1:${listener.port}` };
    const issued = await app.request("/api/v1/session/nonce", { method: "POST", headers: { ...host, Authorization: `Bearer ${token}` } }, listener);
    // The nonce route sends a `SessionNonce` body on 201, and a test that gets another body fails at this parse.
    const { nonce } = nonceSchema.parse(await jsonBody(issued));
    const response = await app.request(`/api/v1/session?nonce=${nonce}&next=/gui/`, { headers: host }, listener);
    const cookie = response.headers.get("Set-Cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error(`signIn: the sign-in answered ${response.status} and set no cookie`);
    return cookie;
}
