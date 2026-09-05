/**
 * The HTTP transport of the service, on `Bun.serve`.
 *
 * The server holds one loaded snapshot for its life. It checks the bearer key
 * when it holds one, parses each body with the request schema, and calls the
 * handler. A parse failure answers 400 with the field and the permitted values.
 * A handler that returns a validation failure answers 400 as well. The
 * snapshot route and the health route answer without a key, because a client
 * uses them to learn which digest it talks to before it sends a situation.
 */

import type { z } from "zod";

import type { LoadedSnapshot } from "../store.js";
import { CheckRequestSchema, RecommendRequestSchema, RenderRequestSchema, type ValidationFailure } from "./api.js";
import { check, claimView, recommend, render, templateContract } from "./handlers.js";

export interface ServiceOptions {
    readonly snapshot: LoadedSnapshot;
    readonly apiKey?: string;
    readonly port?: number;
    readonly hostname?: string;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function validationOf(error: z.ZodError): ValidationFailure {
    return {
        error: "validation",
        message: "the request does not match the contract",
        issues: error.issues.map((issue) => ({
            field: issue.path.join(".") || "(root)",
            message: issue.message,
            ...("values" in issue && Array.isArray((issue as { values?: unknown[] }).values) ? { permitted: ((issue as { values: unknown[] }).values as unknown[]).map(String) } : {}),
        })),
    };
}

async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<{ ok: true; value: z.infer<S> } | { ok: false; response: Response }> {
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return { ok: false, response: json({ error: "validation", message: "the body is not JSON", issues: [] } satisfies ValidationFailure, 400) };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, response: json(validationOf(parsed.error), 400) };
    return { ok: true, value: parsed.data };
}

export function createService(options: ServiceOptions) {
    const { snapshot, apiKey } = options;

    const authorized = (request: Request): boolean => {
        if (!apiKey) return true;
        const header = request.headers.get("authorization") ?? "";
        return header === `Bearer ${apiKey}`;
    };

    const handle = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";

        if (request.method === "GET" && (path === "/health" || path === "/v1/snapshot")) {
            return json(path === "/health" ? { ok: true, digest: snapshot.meta.digest } : snapshot.meta);
        }
        if (!authorized(request)) return json({ error: "unauthorized", message: "a bearer key is required" }, 401);

        if (request.method === "POST" && path === "/v1/recommend") {
            const body = await parseBody(request, RecommendRequestSchema);
            if (!body.ok) return body.response;
            const result = recommend(snapshot, body.value);
            return "error" in result ? json(result, 400) : json(result);
        }
        if (request.method === "POST" && path === "/v1/check") {
            const body = await parseBody(request, CheckRequestSchema);
            if (!body.ok) return body.response;
            const result = check(snapshot, body.value);
            return "error" in result ? json(result, 400) : json(result);
        }
        if (request.method === "POST" && path === "/v1/template/render") {
            const body = await parseBody(request, RenderRequestSchema);
            if (!body.ok) return body.response;
            const result = await render(snapshot, body.value);
            return "error" in result ? json(result, 400) : json(result);
        }
        const claimMatch = path.match(/^\/v1\/claims\/(.+)$/);
        if (request.method === "GET" && claimMatch) {
            const stored = snapshot.rulesByClaim.get(decodeURIComponent(claimMatch[1]!));
            return stored ? json(claimView(snapshot, stored, true)) : json({ error: "not_found", message: "no such claim in this snapshot" }, 404);
        }
        if (request.method === "GET" && path === "/v1/sources") {
            return json([...snapshot.sources.values()].map((source) => ({ id: source.id, ...(source.doi ? { doi: source.doi } : {}), ...(source.pmid ? { pmid: source.pmid } : {}), title: source.title, year: source.year })));
        }
        const templateMatch = path.match(/^\/v1\/templates\/(.+)$/);
        if (request.method === "GET" && templateMatch) {
            const contract = templateContract(snapshot, decodeURIComponent(templateMatch[1]!).split("@")[0]!);
            return contract ? json(contract) : json({ error: "not_found", message: "no such template in this snapshot" }, 404);
        }
        return json({ error: "not_found", message: `no route ${request.method} ${path}` }, 404);
    };

    return {
        fetch: handle,
        listen() {
            return Bun.serve({ port: options.port ?? 8790, hostname: options.hostname ?? "127.0.0.1", fetch: handle });
        },
    };
}
