import type { Context, MiddlewareHandler } from "hono";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { z, type ZodType } from "zod";

import { API_ERROR_STATUS, DEFAULT_PER_PAGE, MAX_PER_PAGE, type ApiError, type ApiErrorCode, type ListEnvelope, type PageQuery } from "../api/common.ts";
import { SIGN_IN_REQUIRED, type ServerState } from "../api/server.ts";
import { getLogger } from "../lib/log.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import type { ServerBoot } from "./boot.ts";

/** The Hono environment of each route: `runtime` is set by {@link requireRuntime}, for the routes behind it. */
export type ServerEnv = {
    Variables: {
        runtime: HarnessRuntime;
    };
};

/** An error response: the {@link ApiError} body, with the HTTP status of its code. */
export function apiError(c: Context, code: ApiErrorCode, message: string, details?: unknown): Response {
    const body: ApiError = details === undefined ? { error: code, message } : { error: code, message, details };
    return c.json(body, API_ERROR_STATUS[code]);
}

/**
 * The 500 `internal_error` response for a module or db `Result` that failed for a reason that the client
 * cannot act on, for example a `DbError` of type `query_failed`. The cause goes to the log only.
 */
export function internalError(c: Context, cause: unknown, action: string): Response {
    getLogger("server").error({ err: cause, method: c.req.method, path: c.req.path }, `could not ${action}`);
    return apiError(c, "internal_error", "The server failed to handle the request.");
}

/**
 * The JSON body of the request, validated by `schema`. The error channel holds the response to send: 400
 * `invalid_json` for a body that is not JSON, and 400 `validation_error` with the zod `flattenError` output
 * in `details` for a body that `schema` refuses.
 */
export async function readBody<T>(c: Context, schema: ZodType<T>): Promise<Result<T, Response>> {
    // `unknown`: the body is external input until `schema` validates it.
    const raw = await ResultAsync.fromPromise(c.req.json<unknown>(), () => null);
    if (raw.isErr()) return err(apiError(c, "invalid_json", "The body is not JSON."));
    const parsed = schema.safeParse(raw.value);
    return parsed.success ? ok(parsed.data) : err(apiError(c, "validation_error", "A field of the body is not correct.", z.flattenError(parsed.error)));
}

/**
 * The page that the `page` and `perPage` query values ask for. A value that is not a non-negative integer
 * (`page`) or a positive integer (`perPage`) falls back to the default and never gives a 400. A `perPage`
 * above {@link MAX_PER_PAGE} gives that cap.
 */
export function parsePage(page: string | undefined, perPage: string | undefined): PageQuery {
    const pageNumber = page !== undefined && /^\d+$/.test(page) ? Number(page) : 0;
    const perPageNumber = perPage !== undefined && /^\d+$/.test(perPage) && Number(perPage) > 0 ? Number(perPage) : DEFAULT_PER_PAGE;
    return { page: pageNumber, perPage: Math.min(perPageNumber, MAX_PER_PAGE) };
}

/** A list response: `items` (one page) under `key`, with the paging fields over `total` items. */
export function listEnvelope<K extends string, T>(key: K, items: T[], total: number, page: PageQuery): ListEnvelope<K, T> {
    // A computed key widens to `string` in TypeScript, so the literal key `K` is restored by the cast. The
    // object carries exactly one items key, which is `key`.
    return { [key]: items, total, page: page.page, perPage: page.perPage, hasMore: (page.page + 1) * page.perPage < total } as ListEnvelope<K, T>;
}

/**
 * A middleware for each route that needs the harness runtime. Until the boot is ready it gives 503
 * `unavailable`, with the boot phase in `details.phase`. After that it sets `runtime` for the handler.
 */
export function requireRuntime(boot: ServerBoot): MiddlewareHandler<ServerEnv> {
    return async (c, next) => {
        const runtime = boot.runtime();
        if (runtime === null) {
            const state = boot.state();
            return apiError(c, "unavailable", unavailableMessage(state), { phase: state.phase });
        }
        c.set("runtime", runtime);
        await next();
    };
}

/**
 * The 503 message for a person: the phase, the cause of a failed boot, and the command after which the server
 * boots again. A command prints it as its remedy, thus it names no API route.
 */
function unavailableMessage(state: ServerState): string {
    if (state.phase !== "failed") return "The Inflexa server is still booting its runtime (phase `starting`). Try again in a moment.";
    const after =
        state.bootError.reason === SIGN_IN_REQUIRED ? "The server boots again after the sign-in." : "Then run `inflexa up`: the server boots again after it.";
    return `The Inflexa server could not boot its runtime (phase \`failed\`). ${state.bootError.message}\n  ${after}`;
}

/**
 * Lift the 10 s idle timeout of `Bun.serve` for this request. Call it in a route whose work can run for longer
 * than 10 s before the response, for example a hash of a large input set or a wait behind the farm queue.
 * Bun closes a connection with no byte for 10 s, and the client then gets no response.
 *
 * Bun 1.4.0 closes only a request with no body, for example a GET or a POST that a client sends with no body.
 * A route that reads a JSON body has no need of the call. `machine.test.ts` pins both sides over a real listener.
 */
export function holdConnection(c: Context): void {
    // `Bun.serve` passes its server as the second argument of `fetch`, which Hono gives as `c.env`.
    // `app.request()` in a test passes none, thus the call is a no-op there.
    const server = c.env as { timeout?: (request: Request, seconds: number) => void } | undefined;
    server?.timeout?.(c.req.raw, 0);
}

/** The interval of the `: ping` comment on an open SSE stream. `Bun.serve` closes a connection that is silent for 10 s. */
export const SSE_PING_MS = 5_000;

/** The send side of an open SSE stream. */
export type SseWriter = {
    /** Sends one `data: <JSON>` frame. After the client disconnects it does nothing. */
    send(frame: unknown): void;
    /** Aborts when the client disconnects. */
    readonly signal: AbortSignal;
};

/** The options of {@link sseResponse}. Tests shorten the ping interval. */
export type SseOpts = {
    readonly pingMs: number;
    /** Extra response headers, for example a turn id. */
    readonly headers: Record<string, string>;
};

/** The production {@link SseOpts}. */
export const DEFAULT_SSE_OPTS: SseOpts = { pingMs: SSE_PING_MS, headers: {} };

/**
 * An SSE response whose frames `produce` sends. Each frame is `data: <JSON>` and a blank line, with no
 * `event:` field and no `id:` field. The stream sends the comment `: open` at once, and `: ping` each
 * `pingMs`. It closes when `produce` settles. A rejected `produce` closes the stream too, after a log line: an error that a client must see
 * is a frame that `produce` sends before it settles.
 */
export function sseResponse(produce: (writer: SseWriter) => Promise<void>, opts: SseOpts = DEFAULT_SSE_OPTS): Response {
    const encoder = new TextEncoder();
    const disconnect = new AbortController();
    let open = true;
    let ping: ReturnType<typeof setInterval> | undefined;

    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const write = (text: string): void => {
                if (open) controller.enqueue(encoder.encode(text));
            };
            const close = (): void => {
                if (!open) return;
                open = false;
                clearInterval(ping);
                controller.close();
            };
            // `Bun.serve` sends the response headers with the first body bytes. The headers carry the id that a
            // client needs to abort the work, thus they cannot wait for the first frame of a slow producer.
            write(": open\n\n");
            ping = setInterval(() => write(": ping\n\n"), opts.pingMs);
            const writer: SseWriter = { send: (frame) => write(`data: ${JSON.stringify(frame)}\n\n`), signal: disconnect.signal };
            void produce(writer).then(close, (cause: unknown) => {
                getLogger("server").error({ err: cause }, "an SSE producer failed");
                close();
            });
        },
        cancel() {
            open = false;
            clearInterval(ping);
            disconnect.abort();
        },
    });

    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...opts.headers } });
}
