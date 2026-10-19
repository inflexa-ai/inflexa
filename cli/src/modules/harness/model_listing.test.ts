import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import "../../extensions/index.ts"; // installs Response.prototype.jsonWith, which listConnectionModels uses
import type { ChatSetupError, ModelAccess } from "../proxy/models.ts";
import { AGENT_EFFORTS } from "../../lib/config.ts";
import type { ResolvedModelConnection } from "./config.ts";
import { listConnectionModels, validateModelSelection, type ListModelsSeams, type ValidateSelectionSeams } from "./model_listing.ts";

// Drives `listConnectionModels` through injected seams so the per-mode request shaping (cliproxy vs.
// direct OpenAI-compatible vs. direct Anthropic) and the Result-channel degradations are exercised with
// no proxy config file, no `process.env`, and no network. Each test records the URL + headers the seam
// saw, pinning the exact request each connection mode issues.

/** Build seams over a fixed connection, a recorded fetch, and configurable credential reads. */
function seamsFor(opts: {
    connection: ResolvedModelConnection;
    // A thunk (not a bare Result): the neverthrow must-use rule flags a Result passed as an argument, so
    // the test hands back a reader whose Result is in RETURN position.
    readProxyKey?: () => Promise<Result<string, ChatSetupError>>;
    modelApiKey?: string | undefined;
    resolveAuthCredential?: ListModelsSeams["resolveAuthCredential"];
    fetch: ListModelsSeams["fetch"];
}): ListModelsSeams {
    return {
        resolveConnection: () => opts.connection,
        readProxyKey: opts.readProxyKey ?? (async () => ok("sk-proxy")),
        readModelApiKey: () => opts.modelApiKey,
        resolveAuthCredential:
            opts.resolveAuthCredential ??
            (() => {
                throw new Error("resolveAuthCredential must not be called without an auth block");
            }),
        fetch: opts.fetch,
    };
}

function modelsResponse(ids: string[], init?: ResponseInit): Response {
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), init);
}

/** A models body whose entries carry a raw `capabilities` block, as Anthropic's GET /v1/models reports it. */
function capabilityResponse(models: { id: string; capabilities: unknown }[]): Response {
    return new Response(JSON.stringify({ data: models }));
}

/** A fetch that records its call and answers with `res`. */
function recordingFetch(res: () => Promise<Response>): { fetch: ListModelsSeams["fetch"]; calls: { url: string; headers: Record<string, string> }[] } {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    return {
        calls,
        fetch: (url, headers) => {
            calls.push({ url, headers });
            return res();
        },
    };
}

describe("listConnectionModels — per-mode request shape", () => {
    test("cliproxy hits the proxy /models with a bearer token and returns the id list", async () => {
        const rec = recordingFetch(() => Promise.resolve(modelsResponse(["claude-sonnet-4-5", "claude-opus-4-8"])));
        const result = await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: rec.fetch }));

        // The proxy reports no capability and serves Claude only, thus each model gets the full ladder.
        // Neither model has a date, thus the ids break the tie.
        expect(result._unsafeUnwrap()).toEqual([
            { id: "claude-opus-4-8", efforts: AGENT_EFFORTS, releasedAt: null },
            { id: "claude-sonnet-4-5", efforts: AGENT_EFFORTS, releasedAt: null },
        ]);
        expect(rec.calls).toHaveLength(1);
        expect(rec.calls[0]?.url).toContain("/v1/models");
        expect(rec.calls[0]?.headers).toEqual({ Authorization: "Bearer sk-proxy" });
    });

    test("direct openai-compatible hits {baseURL}/models with a bearer token", async () => {
        const rec = recordingFetch(() => Promise.resolve(modelsResponse(["gpt-4o", "gpt-4o-mini"])));
        const result = await listConnectionModels(
            seamsFor({
                connection: { mode: "direct", provider: "openai", baseURL: "https://api.example.com/v1", protocol: "openai-compatible", agents: {} },
                modelApiKey: "sk-direct",
                fetch: rec.fetch,
            }),
        );

        // An OpenAI-compatible wire sends the effort name as it is, thus an unreported model gets no ladder.
        expect(result._unsafeUnwrap()).toEqual([
            { id: "gpt-4o", efforts: [], releasedAt: null },
            { id: "gpt-4o-mini", efforts: [], releasedAt: null },
        ]);
        expect(rec.calls[0]?.url).toBe("https://api.example.com/v1/models");
        expect(rec.calls[0]?.headers).toEqual({ Authorization: "Bearer sk-direct" });
    });

    test("direct anthropic appends /models to the same /v1-terminated baseURL the chat path uses", async () => {
        const rec = recordingFetch(() => Promise.resolve(modelsResponse(["claude-sonnet-4-5"])));
        const result = await listConnectionModels(
            seamsFor({
                // The `/v1`-terminated protocol root the chat path POSTs `{baseURL}/messages` to; the
                // listing appends `/models` to that SAME value, so one configured URL serves both paths.
                connection: { mode: "direct", provider: "anthropic", baseURL: "https://api.anthropic.com/v1", protocol: "anthropic", agents: {} },
                modelApiKey: "sk-ant",
                fetch: rec.fetch,
            }),
        );

        expect(result._unsafeUnwrap()).toEqual([{ id: "claude-sonnet-4-5", efforts: AGENT_EFFORTS, releasedAt: null }]);
        expect(rec.calls[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
        expect(rec.calls[0]?.headers).toEqual({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
    });

    test("a configured bearer auth block authenticates the listing like the chat path — Authorization, never x-api-key", async () => {
        const rec = recordingFetch(() => Promise.resolve(modelsResponse(["claude-sonnet-5"])));
        const result = await listConnectionModels(
            seamsFor({
                connection: {
                    mode: "direct",
                    provider: "anthropic",
                    baseURL: "https://gw.corp/v1",
                    protocol: "anthropic",
                    auth: { kind: "command", command: "corp token", scheme: "bearer" },
                    agents: {},
                },
                // The env key is ALSO set: the auth block must supersede it (the chat path's precedence).
                modelApiKey: "sk-env-must-not-be-used",
                resolveAuthCredential: async () => ok({ token: "gw-jwt", scheme: "bearer" }),
                fetch: rec.fetch,
            }),
        );
        expect(result._unsafeUnwrap()).toEqual([{ id: "claude-sonnet-5", efforts: AGENT_EFFORTS, releasedAt: null }]);
        expect(rec.calls[0]?.headers).toEqual({ Authorization: "Bearer gw-jwt", "anthropic-version": "2023-06-01" });
    });

    test("an unresolvable auth source degrades to key_missing (free-text picker), issuing no request", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("must not fetch")));
        const result = await listConnectionModels(
            seamsFor({
                connection: {
                    mode: "direct",
                    provider: "anthropic",
                    baseURL: "https://gw.corp/v1",
                    protocol: "anthropic",
                    auth: { kind: "command", command: "corp token", scheme: "bearer" },
                    agents: {},
                },
                resolveAuthCredential: async () => err({ type: "command_exit_nonzero", command: "corp token", exitCode: 1, stderr: "idp down" }),
                fetch: rec.fetch,
            }),
        );
        expect(result._unsafeUnwrapErr()).toEqual({ type: "key_missing" });
        expect(rec.calls).toHaveLength(0);
    });
});

describe("listConnectionModels — the effort ladder of each model", () => {
    const direct: ResolvedModelConnection = {
        mode: "direct",
        provider: "anthropic",
        baseURL: "https://api.anthropic.com/v1",
        protocol: "anthropic",
        agents: {},
    };
    const yes = { supported: true };
    const no = { supported: false };

    async function effortsFor(capabilities: unknown, connection: ResolvedModelConnection = direct): Promise<readonly string[] | undefined> {
        const rec = recordingFetch(() => Promise.resolve(capabilityResponse([{ id: "claude-x", capabilities }])));
        const result = await listConnectionModels(seamsFor({ connection, modelApiKey: "sk-ant", fetch: rec.fetch }));
        return result._unsafeUnwrap()[0]?.efforts;
    }

    test("a reported capability gives each rung the model supports, in ladder order", async () => {
        expect(await effortsFor({ effort: { supported: true, low: yes, medium: no, high: yes, xhigh: no, max: no } })).toEqual(["low", "high"]);
    });

    test("a model with max but no xhigh gets xhigh, because the provider sends xhigh as max", async () => {
        expect(await effortsFor({ effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: null, max: yes } })).toEqual(AGENT_EFFORTS);
        expect(await effortsFor({ effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: yes, max: no } })).toEqual(AGENT_EFFORTS);
    });

    test("a model that reports effort as unsupported gets no ladder", async () => {
        expect(await effortsFor({ effort: { supported: false } })).toEqual([]);
    });

    test("no capability block falls back by wire: the full ladder for cliproxy and anthropic, none for openai-compatible", async () => {
        expect(await effortsFor(undefined, { mode: "cliproxy", provider: "anthropic", agents: {} })).toEqual(AGENT_EFFORTS);
        expect(await effortsFor({ effort: null })).toEqual(AGENT_EFFORTS);
        expect(
            await effortsFor(undefined, {
                mode: "direct",
                provider: "openai",
                baseURL: "https://api.example.com/v1",
                protocol: "openai-compatible",
                agents: {},
            }),
        ).toEqual([]);
    });

    test("a capability block of an unknown shape costs that model its report only, never the listing", async () => {
        expect(await effortsFor({ effort: { supported: "maybe" } })).toEqual(AGENT_EFFORTS);
    });
});

describe("listConnectionModels — expected failures degrade on the Result channel", () => {
    test("a malformed models block reports connection_invalid without touching the network", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("must not fetch")));
        const result = await listConnectionModels(
            seamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {}, configError: { issues: "models.agents.sandbox: expected string" } },
                fetch: rec.fetch,
            }),
        );

        expect(result._unsafeUnwrapErr()).toEqual({ type: "connection_invalid", issues: "models.agents.sandbox: expected string" });
        expect(rec.calls).toHaveLength(0);
    });

    test("cliproxy with no proxy key is key_missing and issues no request", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("must not fetch")));
        const result = await listConnectionModels(
            seamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {} },
                readProxyKey: async () => err({ type: "proxy_key_missing" }),
                fetch: rec.fetch,
            }),
        );

        expect(result._unsafeUnwrapErr()).toEqual({ type: "key_missing" });
        expect(rec.calls).toHaveLength(0);
    });

    test("direct mode with INFLEXA_MODEL_API_KEY unset is key_missing and issues no request", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("must not fetch")));
        const result = await listConnectionModels(
            seamsFor({
                connection: { mode: "direct", provider: "openai", baseURL: "https://api.example.com/v1", protocol: "openai-compatible", agents: {} },
                modelApiKey: undefined,
                fetch: rec.fetch,
            }),
        );

        expect(result._unsafeUnwrapErr()).toEqual({ type: "key_missing" });
        expect(rec.calls).toHaveLength(0);
    });

    test("a dead endpoint (fetch throws) is unreachable carrying the throw's message", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("connect ECONNREFUSED")));
        const result = await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: rec.fetch }));

        expect(result._unsafeUnwrapErr()).toEqual({ type: "unreachable", detail: "connect ECONNREFUSED" });
    });

    test("an endpoint that never answers is timed_out at the bound, not a request with no end", async () => {
        const hung: ListModelsSeams["fetch"] = (_url, _headers, signal) =>
            new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        const listing = listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: hung }), 50);
        const outcome = await Promise.race([listing, Promise.sleep(1000).then(() => "no answer" as const)]);

        expect(outcome).not.toBe("no answer");
        if (outcome !== "no answer") expect(outcome._unsafeUnwrapErr()).toEqual({ type: "timed_out", afterMs: 50 });
    });

    test("a non-ok response is unreachable naming the status", async () => {
        const rec = recordingFetch(() => Promise.resolve(new Response("nope", { status: 503 })));
        const result = await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: rec.fetch }));

        expect(result._unsafeUnwrapErr()).toEqual({ type: "unreachable", detail: "HTTP 503" });
    });

    test("an empty list — or a body that fails the schema — is no_models", async () => {
        const empty = recordingFetch(() => Promise.resolve(modelsResponse([])));
        expect(
            (
                await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: empty.fetch }))
            )._unsafeUnwrapErr(),
        ).toEqual({
            type: "no_models",
        });

        const garbage = recordingFetch(() => Promise.resolve(new Response("not json at all")));
        expect(
            (
                await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: garbage.fetch }))
            )._unsafeUnwrapErr(),
        ).toEqual({
            type: "no_models",
        });
    });
});

// Drives `validateModelSelection` (the picker's commit-time accessibility check) through injected seams:
// the cliproxy verdict is DELEGATED to checkModelAccess (asserted, never reimplemented here), the
// direct-anthropic `count_tokens` request is shaped + mapped in-file, and every can't-decide branch
// resolves to `inconclusive` so a switch is never blocked by validation. No network, no proxy config.

/** Build validate seams; every effect that a given test does NOT expect throws, so an unwanted call fails loudly. */
function validateSeamsFor(opts: {
    connection: ResolvedModelConnection;
    readProxyKey?: () => Promise<Result<string, ChatSetupError>>;
    modelApiKey?: string | undefined;
    resolveAuthCredential?: ValidateSelectionSeams["resolveAuthCredential"];
    checkModelAccess?: (apiKey: string, modelId: string, signal?: AbortSignal) => Promise<ModelAccess>;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): ValidateSelectionSeams {
    return {
        resolveConnection: () => opts.connection,
        readProxyKey: opts.readProxyKey ?? (async () => ok("sk-proxy")),
        readModelApiKey: () => opts.modelApiKey,
        resolveAuthCredential:
            opts.resolveAuthCredential ??
            (() => {
                throw new Error("resolveAuthCredential must not be called without an auth block");
            }),
        checkModelAccess:
            opts.checkModelAccess ??
            (() => {
                throw new Error("checkModelAccess must not be called");
            }),
        fetch:
            opts.fetch ??
            (() => {
                throw new Error("fetch must not be called");
            }),
    };
}

const DIRECT_ANTHROPIC: ResolvedModelConnection = {
    mode: "direct",
    provider: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    protocol: "anthropic",
    agents: {},
};

/** A models body whose entries carry the raw date fields of the sources, with the paging fields of Anthropic's route. */
function datedResponse(models: { id: string; created?: unknown; created_at?: unknown }[], paging: { has_more?: boolean; last_id?: string } = {}): Response {
    return new Response(JSON.stringify({ data: models, ...paging }));
}

describe("listConnectionModels — the release date and the newest-first order", () => {
    const cliproxy: ResolvedModelConnection = { mode: "cliproxy", provider: "anthropic", agents: {} };
    const sept21 = "2026-09-21T00:00:00.000Z";

    async function listFor(models: { id: string; created?: unknown; created_at?: unknown }[], connection: ResolvedModelConnection = cliproxy) {
        const rec = recordingFetch(() => Promise.resolve(datedResponse(models)));
        return (await listConnectionModels(seamsFor({ connection, modelApiKey: "sk-ant", fetch: rec.fetch })))._unsafeUnwrap();
    }

    test("each model carries releasedAt as the ISO 8601 form of `created_at` or `created`", async () => {
        const listing = await listFor([
            { id: "claude-rfc", created_at: "2026-09-21T00:00:00Z" },
            { id: "claude-unix", created: 1_760_000_000 },
        ]);
        expect(listing.map((m) => [m.id, m.releasedAt])).toEqual([
            ["claude-rfc", sept21],
            ["claude-unix", "2025-10-09T08:53:20.000Z"],
        ]);
    });

    test("an epoch date, an earlier date, an invalid date, and a missing date give releasedAt null", async () => {
        const listing = await listFor([
            { id: "claude-epoch", created_at: "1970-01-01T00:00:00Z" },
            { id: "claude-before", created: -100 },
            { id: "claude-invalid", created_at: "not a date" },
            { id: "claude-none" },
        ]);
        expect(listing.map((m) => m.releasedAt)).toEqual([null, null, null, null]);
    });

    test("a finite date that a JavaScript Date cannot represent gives releasedAt null and never throws", async () => {
        const listing = await listFor([
            { id: "claude-far", created: 1e15 },
            { id: "claude-ok", created: 1_760_000_000 },
        ]);
        expect(listing.map((m) => [m.id, m.releasedAt])).toEqual([
            ["claude-ok", "2025-10-09T08:53:20.000Z"],
            ["claude-far", null],
        ]);
    });

    test("a date field of an unknown shape costs that date only, never the listing", async () => {
        const listing = await listFor([
            { id: "claude-odd", created: "soon", created_at: { when: "yesterday" } },
            { id: "claude-ok", created: 1_760_000_000 },
        ]);
        expect(listing.map((m) => [m.id, m.releasedAt])).toEqual([
            ["claude-ok", "2025-10-09T08:53:20.000Z"],
            ["claude-odd", null],
        ]);
    });

    test("the listing comes newest first, and an undated model comes last whatever the serving order", async () => {
        const listing = await listFor([
            { id: "claude-older", created: 1_700_000_000 },
            { id: "claude-undated" },
            { id: "claude-newer", created_at: "2026-09-21T00:00:00Z" },
        ]);
        expect(listing.map((m) => m.id)).toEqual(["claude-newer", "claude-older", "claude-undated"]);
    });

    test("the ids break a tie of dates, in ascending order", async () => {
        const listing = await listFor([
            { id: "claude-b", created: 1_700_000_000 },
            { id: "claude-a", created: 1_700_000_000 },
            { id: "claude-z" },
            { id: "claude-y" },
        ]);
        expect(listing.map((m) => m.id)).toEqual(["claude-a", "claude-b", "claude-y", "claude-z"]);
    });

    test("the OpenAI-compatible and the direct Anthropic wires sort the same way", async () => {
        const models = [{ id: "m-old", created: 1_600_000_000 }, { id: "m-none" }, { id: "m-new", created: 1_760_000_000 }];
        const openai = await listFor(models, {
            mode: "direct",
            provider: "openai",
            baseURL: "https://api.example.com/v1",
            protocol: "openai-compatible",
            agents: {},
        });
        const anthropic = await listFor(models, DIRECT_ANTHROPIC);
        expect(openai.map((m) => m.id)).toEqual(["m-new", "m-old", "m-none"]);
        expect(anthropic.map((m) => m.id)).toEqual(["m-new", "m-old", "m-none"]);
    });
});

describe("listConnectionModels — the pages of the direct Anthropic listing", () => {
    const withAuth: ResolvedModelConnection = { ...DIRECT_ANTHROPIC, auth: { kind: "command", command: "corp token", scheme: "bearer" } };

    /** A fetch that answers its n-th call with the n-th of `pages`, and rejects a call after the last page. */
    function pagedFetch(pages: Response[]): ReturnType<typeof recordingFetch> {
        let next = 0;
        return recordingFetch(() => {
            const page = pages[next++];
            return page === undefined ? Promise.reject(new Error("read a page that the test did not serve")) : Promise.resolve(page);
        });
    }

    const listWith = (connection: ResolvedModelConnection, rec: ReturnType<typeof recordingFetch>) =>
        listConnectionModels(
            seamsFor({
                connection,
                modelApiKey: "sk-ant",
                resolveAuthCredential: async () => ok({ token: "gw-jwt", scheme: "bearer" }),
                fetch: rec.fetch,
            }),
        );

    test("the first request asks for 1000 models, and the next request carries the last_id of the page", async () => {
        const rec = pagedFetch([
            datedResponse([{ id: "claude-b", created: 200 }], { has_more: true, last_id: "claude-b" }),
            datedResponse([{ id: "claude-a", created: 100 }], { has_more: false, last_id: "claude-a" }),
        ]);
        const listing = (await listWith(DIRECT_ANTHROPIC, rec))._unsafeUnwrap();

        expect(rec.calls.map((c) => c.url)).toEqual([
            "https://api.anthropic.com/v1/models?limit=1000",
            "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-b",
        ]);
        expect(listing.map((m) => m.id)).toEqual(["claude-b", "claude-a"]);
    });

    test("the models of all pages are sorted together, not page by page", async () => {
        const rec = pagedFetch([
            datedResponse([{ id: "claude-old", created: 100 }], { has_more: true, last_id: "claude-old" }),
            datedResponse([{ id: "claude-new", created: 900 }], { has_more: false, last_id: "claude-new" }),
        ]);
        expect((await listWith(DIRECT_ANTHROPIC, rec))._unsafeUnwrap().map((m) => m.id)).toEqual(["claude-new", "claude-old"]);
    });

    test("a configured auth block pages the same way and sends the same headers on each page", async () => {
        const rec = pagedFetch([
            datedResponse([{ id: "claude-b" }], { has_more: true, last_id: "claude-b" }),
            datedResponse([{ id: "claude-a" }], { has_more: false, last_id: "claude-a" }),
        ]);
        const listing = (await listWith(withAuth, rec))._unsafeUnwrap();

        expect(listing.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
        expect(rec.calls.map((c) => c.url)).toEqual([
            "https://api.anthropic.com/v1/models?limit=1000",
            "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-b",
        ]);
        for (const call of rec.calls) expect(call.headers).toEqual({ Authorization: "Bearer gw-jwt", "anthropic-version": "2023-06-01" });
    });

    test("the read ends at has_more false, and it ends when has_more is absent", async () => {
        const stops = pagedFetch([datedResponse([{ id: "claude-a" }], { has_more: false, last_id: "claude-a" })]);
        await listWith(DIRECT_ANTHROPIC, stops);
        expect(stops.calls).toHaveLength(1);

        const absent = pagedFetch([datedResponse([{ id: "claude-a" }], { last_id: "claude-a" })]);
        await listWith(DIRECT_ANTHROPIC, absent);
        expect(absent.calls).toHaveLength(1);
    });

    test("a repeated last_id ends the read, keeps the models that were read, and lists a repeated id one time", async () => {
        const rec = pagedFetch([
            datedResponse([{ id: "claude-a", created: 100 }], { has_more: true, last_id: "claude-a" }),
            datedResponse(
                [
                    { id: "claude-a", created: 900 },
                    { id: "claude-b", created: 50 },
                ],
                { has_more: true, last_id: "claude-a" },
            ),
        ]);
        const listing = (await listWith(DIRECT_ANTHROPIC, rec))._unsafeUnwrap();

        expect(rec.calls).toHaveLength(2);
        expect(listing.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
        expect(listing[0]!.releasedAt).toBe(new Date(100_000).toISOString());
    });

    test("a page with no last_id, and an empty later page, end the read", async () => {
        const noCursor = pagedFetch([datedResponse([{ id: "claude-a" }], { has_more: true })]);
        expect((await listWith(DIRECT_ANTHROPIC, noCursor))._unsafeUnwrap()).toHaveLength(1);
        expect(noCursor.calls).toHaveLength(1);

        const emptyLater = pagedFetch([
            datedResponse([{ id: "claude-a" }], { has_more: true, last_id: "claude-a" }),
            datedResponse([], { has_more: true, last_id: "claude-z" }),
        ]);
        expect((await listWith(DIRECT_ANTHROPIC, emptyLater))._unsafeUnwrap().map((m) => m.id)).toEqual(["claude-a"]);
        expect(emptyLater.calls).toHaveLength(2);
    });

    test("the read ends at the page cap of 10 pages, and the listing gives the models that it read", async () => {
        let served = 0;
        const rec = recordingFetch(() => {
            served++;
            return Promise.resolve(datedResponse([{ id: `claude-${String(served).padStart(2, "0")}` }], { has_more: true, last_id: `cursor-${served}` }));
        });
        const listing = (await listWith(DIRECT_ANTHROPIC, rec))._unsafeUnwrap();

        expect(rec.calls).toHaveLength(10);
        expect(listing).toHaveLength(10);
    });

    test("a failed later page fails the listing with the reason of a failed first page", async () => {
        const first = datedResponse([{ id: "claude-a" }], { has_more: true, last_id: "claude-a" });
        const status = pagedFetch([first, new Response("nope", { status: 500 })]);
        expect((await listWith(DIRECT_ANTHROPIC, status))._unsafeUnwrapErr()).toEqual({ type: "unreachable", detail: "HTTP 500" });

        let pageNo = 0;
        const throwing = recordingFetch(() =>
            pageNo++ === 0 ? Promise.resolve(datedResponse([{ id: "claude-a" }], { has_more: true, last_id: "claude-a" })) : Promise.reject(new Error("reset")),
        );
        expect((await listWith(DIRECT_ANTHROPIC, throwing))._unsafeUnwrapErr()).toEqual({ type: "unreachable", detail: "reset" });

        const garbage = pagedFetch([datedResponse([{ id: "claude-a" }], { has_more: true, last_id: "claude-a" }), new Response("not json at all")]);
        expect((await listWith(DIRECT_ANTHROPIC, garbage))._unsafeUnwrapErr()).toEqual({ type: "no_models" });
    });

    test("one timeout bounds all pages together", async () => {
        let pageNo = 0;
        const fetchPages: ListModelsSeams["fetch"] = (_url, _headers, signal) =>
            pageNo++ === 0
                ? Promise.resolve(datedResponse([{ id: "claude-a" }], { has_more: true, last_id: "claude-a" }))
                : new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        const outcome = await listConnectionModels(seamsFor({ connection: DIRECT_ANTHROPIC, modelApiKey: "sk-ant", fetch: fetchPages }), 50);
        expect(outcome._unsafeUnwrapErr()).toEqual({ type: "timed_out", afterMs: 50 });
    });

    test("the cliproxy mode and the OpenAI-compatible protocol send no limit and read one page", async () => {
        const proxy = recordingFetch(() => Promise.resolve(datedResponse([{ id: "claude-a" }], { has_more: true, last_id: "claude-a" })));
        await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: proxy.fetch }));
        expect(proxy.calls).toHaveLength(1);
        expect(proxy.calls[0]?.url).not.toContain("limit");

        const openai = recordingFetch(() => Promise.resolve(datedResponse([{ id: "gpt-4o" }], { has_more: true, last_id: "gpt-4o" })));
        await listConnectionModels(
            seamsFor({
                connection: { mode: "direct", provider: "openai", baseURL: "https://api.example.com/v1", protocol: "openai-compatible", agents: {} },
                modelApiKey: "sk-direct",
                fetch: openai.fetch,
            }),
        );
        expect(openai.calls.map((c) => c.url)).toEqual(["https://api.example.com/v1/models"]);
    });
});

describe("validateModelSelection — per-mode commit validation", () => {
    test("cliproxy delegates to checkModelAccess with the proxy key and returns its verdict", async () => {
        const seen: { apiKey: string; modelId: string }[] = [];
        const result = await validateModelSelection(
            "claude-opus-4-8",
            validateSeamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {} },
                checkModelAccess: async (apiKey, modelId) => {
                    seen.push({ apiKey, modelId });
                    return "served";
                },
            }),
        );
        expect(result).toBe("served");
        expect(seen).toEqual([{ apiKey: "sk-proxy", modelId: "claude-opus-4-8" }]);
    });

    test("cliproxy with no proxy key is inconclusive and never delegates", async () => {
        let delegated = 0;
        const result = await validateModelSelection(
            "claude-opus-4-8",
            validateSeamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {} },
                readProxyKey: async () => err({ type: "proxy_key_missing" }),
                checkModelAccess: async () => {
                    delegated++;
                    return "served";
                },
            }),
        );
        expect(result).toBe("inconclusive");
        expect(delegated).toBe(0);
    });

    test("direct-anthropic 200 is served, POSTing count_tokens with the x-api-key + version headers", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const result = await validateModelSelection(
            "claude-sonnet-4-5",
            validateSeamsFor({
                connection: DIRECT_ANTHROPIC,
                modelApiKey: "sk-ant",
                fetch: async (url, init) => {
                    calls.push({ url, init });
                    return new Response("{}", { status: 200 });
                },
            }),
        );
        expect(result).toBe("served");
        expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
        expect(calls[0]?.init.method).toBe("POST");
        expect(calls[0]?.init.headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
    });

    test("a configured bearer auth block authenticates count_tokens like the chat path, superseding the env key", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const result = await validateModelSelection(
            "claude-sonnet-5",
            validateSeamsFor({
                connection: { ...DIRECT_ANTHROPIC, auth: { kind: "command", command: "corp token", scheme: "bearer" } },
                modelApiKey: "sk-env-must-not-be-used",
                resolveAuthCredential: async () => ok({ token: "gw-jwt", scheme: "bearer" }),
                fetch: async (url, init) => {
                    calls.push({ url, init });
                    return new Response("{}", { status: 200 });
                },
            }),
        );
        expect(result).toBe("served");
        expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer gw-jwt", "anthropic-version": "2023-06-01" });
        expect((calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
    });

    test("an unresolvable auth source is inconclusive — the switch commits, no request is issued", async () => {
        let fetched = 0;
        const result = await validateModelSelection(
            "claude-sonnet-5",
            validateSeamsFor({
                connection: { ...DIRECT_ANTHROPIC, auth: { kind: "env", var: "CORP_TOKEN", scheme: "bearer" } },
                resolveAuthCredential: async () => err({ type: "env_var_unset", var: "CORP_TOKEN" }),
                fetch: async () => {
                    fetched++;
                    return new Response("{}", { status: 200 });
                },
            }),
        );
        expect(result).toBe("inconclusive");
        expect(fetched).toBe(0);
    });

    test("direct-anthropic 404 with a not_found_error body is not_found", async () => {
        const result = await validateModelSelection(
            "claude-nope",
            validateSeamsFor({
                connection: DIRECT_ANTHROPIC,
                modelApiKey: "sk-ant",
                fetch: async () => new Response(JSON.stringify({ error: { type: "not_found_error" } }), { status: 404 }),
            }),
        );
        expect(result).toBe("not_found");
    });

    test("direct-anthropic 404 WITHOUT a not_found_error body is inconclusive (matches checkModelAccess)", async () => {
        const result = await validateModelSelection(
            "claude-sonnet-4-5",
            validateSeamsFor({
                connection: DIRECT_ANTHROPIC,
                modelApiKey: "sk-ant",
                // A proxy/gateway that does not route count_tokens 404s everything — a bare 404 must NOT read
                // as inaccessible, only `not_found_error` does.
                fetch: async () => new Response("Not Found", { status: 404 }),
            }),
        );
        expect(result).toBe("inconclusive");
    });

    test("direct-anthropic whose request throws (timeout/abort) is inconclusive", async () => {
        const result = await validateModelSelection(
            "claude-sonnet-4-5",
            validateSeamsFor({
                connection: DIRECT_ANTHROPIC,
                modelApiKey: "sk-ant",
                fetch: async () => {
                    throw new Error("The operation timed out");
                },
            }),
        );
        expect(result).toBe("inconclusive");
    });

    test("direct openai-compatible is inconclusive without issuing any request", async () => {
        let fetchCount = 0;
        const result = await validateModelSelection(
            "gpt-4o",
            validateSeamsFor({
                connection: { mode: "direct", provider: "openai", baseURL: "https://api.example.com/v1", protocol: "openai-compatible", agents: {} },
                modelApiKey: "sk-direct",
                fetch: async () => {
                    fetchCount++;
                    return new Response("{}");
                },
            }),
        );
        expect(result).toBe("inconclusive");
        expect(fetchCount).toBe(0);
    });

    test("an invalid connection config is inconclusive without touching any validation effect", async () => {
        let touched = 0;
        const result = await validateModelSelection(
            "claude-opus-4-8",
            validateSeamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {}, configError: { issues: "models.agents.sandbox: expected string" } },
                checkModelAccess: async () => {
                    touched++;
                    return "served";
                },
                fetch: async () => {
                    touched++;
                    return new Response("{}");
                },
            }),
        );
        expect(result).toBe("inconclusive");
        expect(touched).toBe(0);
    });
});
