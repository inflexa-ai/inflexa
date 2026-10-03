import { Hono } from "hono";

// The `file` import attribute gives the path of the page, and `bun build --compile` embeds the file (refer to
// tui/grammars/register.ts).
import pocPage from "../gui/poc.html" with { type: "file" };
import type { ServerEnv } from "../http.ts";

// bun-types types each `.html` import as the `HTMLBundle` of the HTML loader. The `file` attribute replaces that
// loader, thus the value is the path string.
const POC_PAGE_PATH = pocPage as unknown as string;

/**
 * The proof-of-concept web GUI: one static page that uses the API of the server, as the TUI does. The page holds no
 * secret, thus it needs no bearer token. It reads the token from the fragment of its URL (`/gui/#token=<token>`), and
 * it sends the token on each API call.
 */
export function guiRoutes(): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    routes.get("/", () => new Response(Bun.file(POC_PAGE_PATH), { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    return routes;
}
