import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";

import { API_ERROR_STATUS, type ApiError } from "../api/common.ts";
import type { ServerDiscovery } from "../api/server.ts";
import { env } from "../lib/env.ts";
import { readFileResult, type FsError } from "../lib/fs.ts";

/** Where a client sends its requests, and the bearer token that it sends with each one. */
export type ServerEndpoint = {
    readonly baseUrl: string;
    readonly token: string;
};

/** Why a request to the local server failed. */
export type ClientError =
    /** No server answers: no usable discovery file (no server runs), or no listener on the port. */
    | { type: "unreachable"; reason: "not_running" | "connection_failed"; baseUrl: string; cause: unknown }
    /** The caller aborted the request through its signal. */
    | { type: "aborted" }
    /** The server answered with an error status and an {@link ApiError} body. */
    | { type: "http"; status: number; body: ApiError }
    /** The body is not JSON, or an error body is not an {@link ApiError}. */
    | { type: "bad_json"; status: number; detail: string };

/** The method of a request to the local server. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The parts of a request that a fetcher supplies. */
export type ApiRequest = {
    /** Sent as the JSON body. */
    readonly body?: unknown;
    readonly signal?: AbortSignal;
    /** More request headers, for a value that must not ride the URL, for example a secret. */
    readonly headers?: Record<string, string>;
};

/** How a client finds the server and sends a request. Tests replace both. */
export type ClientOpts = {
    readonly discover: () => Result<ServerEndpoint, ClientError>;
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
};

/** The production {@link ClientOpts}: the discovery file of this build channel, and the global `fetch`. */
export const DEFAULT_CLIENT_OPTS: ClientOpts = {
    discover: discoverServer,
    fetch: (url, init) => fetch(url, init),
};

/** The base URL of a server on `port`. The server binds `127.0.0.1` only. */
export function serverBaseUrl(port: number): string {
    return `http://127.0.0.1:${port}`;
}

const discoverySchema = z.object({
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65535),
    token: z.string().min(1),
    version: z.string(),
    apiVersion: z.number().int(),
    startedAt: z.string(),
    channel: z.enum(["development", "production"]),
});

/**
 * The discovery file at `path`, or `null` when no usable file is there: an absent file, or a file that is not
 * a discovery record. The error channel holds a file that exists but cannot be read.
 */
export function readServerDiscovery(path: string = env.serverFilePath): Result<ServerDiscovery | null, FsError> {
    return (
        readFileResult(path, "read the server discovery file")
            .map((raw): ServerDiscovery | null => JSON.parseWith(raw, discoverySchema))
            // `readFileSync` throws a Node errno error. A cause with no `code` reads as a failure that is not ENOENT.
            .orElse((e) => ((e.cause as NodeJS.ErrnoException | null)?.code === "ENOENT" ? ok(null) : err(e)))
    );
}

/**
 * Find the local server through its discovery file: its port, and the token that it wrote at its start. The
 * file is read again at each request, thus a client that outlives a server restart sends the new token.
 */
export function discoverServer(): Result<ServerEndpoint, ClientError> {
    const baseUrl = serverBaseUrl(env.serverPort);
    return readServerDiscovery()
        .mapErr((e): ClientError => ({ type: "unreachable", reason: "not_running", baseUrl, cause: e.cause }))
        .andThen((discovery) =>
            discovery === null
                ? err<ServerEndpoint, ClientError>({ type: "unreachable", reason: "not_running", baseUrl, cause: null })
                : ok({ baseUrl: serverBaseUrl(discovery.port), token: discovery.token }),
        );
}

/**
 * Who reads the messages of {@link describeClientError} in this process: a command, or the chat. A send of the
 * chat does not start a server, as a command does: the chat offers the start in a dialog.
 */
export type ClientSurface = "command" | "chat";

let surface: ClientSurface = "command";

/** Name the {@link ClientSurface} of this process. The chat sets `chat` one time, before it renders. */
export function setClientSurface(next: ClientSurface): void {
    surface = next;
}

/**
 * One line for a person, for each {@link ClientError}. An unreachable server says what starts one on the
 * {@link ClientSurface} of this process, and names the command that shows the server.
 */
export function describeClientError(e: ClientError): string {
    switch (e.type) {
        case "unreachable": {
            const missing =
                e.reason === "not_running" ? `No Inflexa server runs: ${env.serverFilePath} names none.` : `No Inflexa server answers at ${e.baseUrl}.`;
            const starter =
                surface === "chat"
                    ? "This chat offers to start it, and each `inflexa` command starts it too."
                    : "The next inflexa command that needs a server starts it.";
            return `${missing} ${starter} \`inflexa server status\` shows it.`;
        }
        case "aborted":
            return "The request to the Inflexa server was canceled.";
        case "http":
            return `${e.body.message} (HTTP ${e.status} ${e.body.error})`;
        case "bad_json":
            return `The Inflexa server sent a body that is not the expected JSON (HTTP ${e.status}): ${e.detail}`;
        default: {
            const exhaustive: never = e;
            throw new Error(`unhandled client error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * Send one JSON request to the local server, and give the JSON body of a success status as `T`.
 *
 * `T` is not validated at runtime. The server builds each body from the same `src/api/` type, and a command
 * connects only to a server of the same `apiVersion` (`ensureServer` in client/server.ts), thus the declared
 * type is the shape that arrives.
 */
export function request<T>(method: HttpMethod, path: string, req: ApiRequest = {}, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<T, ClientError> {
    return send(method, path, req, "application/json", opts).andThen(({ response, baseUrl }) =>
        readJsonBody(response, baseUrl, req.signal).andThen((body): Result<T, ClientError> => {
            if (!response.ok) return err(errorFromBody(response.status, body));
            // The cast is sound for the reason in the JSDoc above: one checkout builds both sides of the wire.
            return ok(body as T);
        }),
    );
}

/**
 * Open an SSE response of the local server, and give its frames as they arrive.
 *
 * A refusal before the first frame is a JSON error body with an error status, thus it comes back on the
 * error channel of the result, the same as from {@link request}. After the stream opens, an error is a
 * frame of the stream, or a `connection_failed` item when the connection breaks.
 */
export function streamRequest<T>(
    method: HttpMethod,
    path: string,
    req: ApiRequest = {},
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<AsyncGenerator<Result<T, ClientError>>, ClientError> {
    return openStream<T>(method, path, req, opts).map((stream) => stream.frames);
}

/** An open SSE response: its headers, and its frames as they arrive. */
export type OpenStream<T> = {
    readonly headers: Headers;
    readonly frames: AsyncGenerator<Result<T, ClientError>>;
};

/** {@link streamRequest}, with the response headers, for a stream whose header names the resource, for example the turn id of a chat turn. */
export function openStream<T>(
    method: HttpMethod,
    path: string,
    req: ApiRequest = {},
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<OpenStream<T>, ClientError> {
    return send(method, path, req, "text/event-stream", opts).andThen(({ response, baseUrl }) => {
        if (!response.ok) return readJsonBody(response, baseUrl, req.signal).andThen((body) => errAsync(errorFromBody(response.status, body)));
        if (response.body === null) return errAsync<never, ClientError>({ type: "bad_json", status: response.status, detail: "the stream has no body" });
        return okAsync({ headers: response.headers, frames: readSseFrames<T>(response.body, baseUrl) });
    });
}

/**
 * Parse an SSE body into its frames. Each frame of this API is one `data:` line of JSON and a blank line.
 * A comment line (the `: open` line at the start of a stream, and the `: ping` heartbeat of the server) and
 * a field other than `data:` carry nothing for the reader. A frame that is not JSON gives a `bad_json` item, and the reader continues with the next one.
 * A broken connection gives one `connection_failed` item, then the reader ends.
 */
export async function* readSseFrames<T>(body: ReadableStream<Uint8Array>, baseUrl: string): AsyncGenerator<Result<T, ClientError>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    try {
        for (;;) {
            const chunk = await ResultAsync.fromPromise(reader.read(), (cause): ClientError => ({
                type: "unreachable",
                reason: "connection_failed",
                baseUrl,
                cause,
            }));
            if (chunk.isErr()) {
                // eslint-disable-next-line neverthrow/must-use-result -- a yielded Result is consumed by the `for await` of the caller, which the rule cannot follow
                yield err(chunk.error);
                return;
            }
            if (chunk.value.done) return;
            buffer += decoder.decode(chunk.value.value, { stream: true });
            for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
                const line = buffer.slice(0, newline).replace(/\r$/, "");
                buffer = buffer.slice(newline + 1);
                if (line === "") {
                    // eslint-disable-next-line neverthrow/must-use-result -- a yielded Result is consumed by the `for await` of the caller, which the rule cannot follow
                    if (data.length > 0) yield parseFrame<T>(data.join("\n"));
                    data = [];
                } else if (line.startsWith("data:")) {
                    data.push(line.slice("data:".length).replace(/^ /, ""));
                }
            }
        }
    } finally {
        // A consumer that stops early leaves the body open. The cancel releases the connection, and a
        // cancel of a finished stream is a no-op.
        void reader.cancel().catch(() => undefined);
    }
}

function send(
    method: HttpMethod,
    path: string,
    req: ApiRequest,
    accept: string,
    opts: ClientOpts,
): ResultAsync<{ response: Response; baseUrl: string }, ClientError> {
    return opts.discover().asyncAndThen((endpoint) =>
        ResultAsync.fromPromise(
            opts.fetch(`${endpoint.baseUrl}${path}`, {
                method,
                headers: {
                    ...req.headers,
                    Authorization: `Bearer ${endpoint.token}`,
                    Accept: accept,
                    ...(req.body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
                ...(req.signal === undefined ? {} : { signal: req.signal }),
            }),
            (cause) => connectionError(endpoint.baseUrl, req.signal, cause),
        ).map((response) => ({ response, baseUrl: endpoint.baseUrl })),
    );
}

/** The parsed JSON body. A body that is not JSON is a `bad_json` error that carries the start of the text. */
function readJsonBody(response: Response, baseUrl: string, signal: AbortSignal | undefined): ResultAsync<unknown, ClientError> {
    return ResultAsync.fromPromise(response.text(), (cause) => connectionError(baseUrl, signal, cause)).andThen((text) =>
        parseJson(text).mapErr((): ClientError => ({ type: "bad_json", status: response.status, detail: text.slice(0, 200) })),
    );
}

/** A failed fetch or body read: `aborted` when the caller aborted, else the connection broke. */
function connectionError(baseUrl: string, signal: AbortSignal | undefined, cause: unknown): ClientError {
    return signal?.aborted ? { type: "aborted" } : { type: "unreachable", reason: "connection_failed", baseUrl, cause };
}

/** `unknown`: the body is external input until a caller gives it a type. */
const parseJson = Result.fromThrowable(
    (text: string): unknown => JSON.parse(text),
    (cause) => cause,
);

function parseFrame<T>(data: string): Result<T, ClientError> {
    // The cast is sound for the reason in the JSDoc of `request`: one checkout builds both sides of the wire.
    return parseJson(data)
        .map((frame) => frame as T)
        .mapErr((): ClientError => ({ type: "bad_json", status: 200, detail: data.slice(0, 200) }));
}

function errorFromBody(status: number, body: unknown): ClientError {
    return isApiError(body) ? { type: "http", status, body } : { type: "bad_json", status, detail: "the error body is not an API error" };
}

/** A type predicate over the JSON of an error body: sound because it tests each required field, and `error` against the closed set of codes. */
function isApiError(value: unknown): value is ApiError {
    if (typeof value !== "object" || value === null) return false;
    // A non-null object indexes as a record of unknown values. Each field is tested before the predicate holds.
    const record = value as Record<string, unknown>;
    return typeof record["error"] === "string" && Object.hasOwn(API_ERROR_STATUS, record["error"]) && typeof record["message"] === "string";
}
