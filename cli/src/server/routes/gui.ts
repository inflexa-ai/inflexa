import { Hono } from "hono";

import type { ServerEnv } from "../http.ts";

const PLACEHOLDER_PAGE =
    '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Inflexa</title></head>\n<body><p>Not implemented</p></body>\n</html>\n';

/**
 * The page at `/gui/`: a placeholder with no script and no token, thus it needs no credential. It is the
 * target of the browser sign-in of `inflexa gui`.
 */
export function guiRoutes(): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    routes.get("/", (c) => c.html(PLACEHOLDER_PAGE));
    return routes;
}
