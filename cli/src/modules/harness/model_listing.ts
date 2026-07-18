import { type Result, ok, err } from "neverthrow";
import { z } from "zod";

import { env, resolveModelApiKey } from "../../lib/env.ts";
import { readApiKey, checkModelAccess, type ChatSetupError, type ModelAccess } from "../proxy/models.ts";
import { resolveModelConnection, type ResolvedModelConnection } from "./config.ts";

// Live model listing for the agent-model picker. Deliberately DISTINCT from
// `resolveModelId` (proxy/models.ts): that resolves ONE default id for boot and CACHES it per process
// (a session's model is fixed, so caching is right there); the picker wants the CURRENT, UNCACHED list
// on every open, and it must speak whatever protocol the CONFIGURED connection uses — the owned
// cliproxy, a direct OpenAI-compatible endpoint, or a direct Anthropic endpoint — not just the proxy.
//
// Homed here, not in proxy/models.ts, because it needs the resolved model connection
// (`ResolvedModelConnection`, harness-owned): a proxy/models.ts helper reaching into harness/config
// would invert the harness → proxy module dependency direction (CLAUDE.md). It reuses proxy's
// `readApiKey` (the cliproxy client-key discovery) for the cliproxy mode only.
//
// Listing failure is an EXPECTED outcome — the picker degrades to free-text entry — so every
// failure mode is modeled on the Result error channel, never thrown.

// Every supported endpoint answers the OpenAI-style `{ data: [{ id }] }` shape: the cliproxy /models
// route, an OpenAI-compatible /models, AND Anthropic's GET /v1/models (whose `data[].id` carries the
// model id). One schema covers all three; unmodeled fields are ignored.
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

// Anthropic requires a version header on every request, GET /v1/models included. Pinned to the stable
// published date the Messages API uses; the list-models route is version-stable, so this constant does
// NOT track model releases.
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Why a model listing could not be produced — each an EXPECTED degradation the picker maps to free-text
 * entry, never a crash:
 * - `connection_invalid` — the `models` config block failed validation (the same fields boot reports);
 * - `key_missing` — no credential to authenticate the listing request (the cliproxy client key is
 *   absent, or `INFLEXA_MODEL_API_KEY` is unset in direct mode);
 * - `unreachable` — the endpoint threw, timed out, or answered non-2xx (`detail` carries the reason);
 * - `no_models` — the endpoint answered but listed nothing (empty `data`, or a body that failed the schema).
 */
export type ListModelsError =
    { type: "connection_invalid"; issues: string } | { type: "key_missing" } | { type: "unreachable"; detail: string } | { type: "no_models" };

/**
 * The effectful seams, injectable so the per-mode request-shaping is unit-testable offline (no real
 * proxy config file, no `process.env`, no network) — mirrors `BootSeams`/`RefreshSeams`. Production
 * callers omit the argument and get the real connection resolution + credential reads + `fetch`.
 */
export type ListModelsSeams = {
    /** The resolved model connection (mode/provider/protocol/baseURL/agents). Real: {@link resolveModelConnection}. */
    readonly resolveConnection: () => ResolvedModelConnection;
    /** Discover the cliproxy client key from the proxy config. Real: {@link readApiKey}. */
    readonly readProxyKey: () => Promise<Result<string, ChatSetupError>>;
    /**
     * The direct-mode secret from the environment, resolved for the connection's configured provider
     * (INFLEXA_MODEL_API_KEY, else the provider-conventional variable). Real: {@link resolveModelApiKey}.
     */
    readonly readModelApiKey: (provider: string) => string | undefined;
    /** Issue the GET request with the mode-specific headers. Real: `fetch(url, { headers })`. */
    readonly fetch: (url: string, headers: Record<string, string>) => Promise<Response>;
};

const realSeams: ListModelsSeams = {
    resolveConnection: resolveModelConnection,
    readProxyKey: readApiKey,
    readModelApiKey: resolveModelApiKey,
    fetch: (url, headers) => fetch(url, { headers }),
};

/** The endpoint + auth headers to enumerate models for `connection`, or a `key_missing` when the credential is absent. */
async function requestFor(
    connection: ResolvedModelConnection,
    seams: ListModelsSeams,
): Promise<Result<{ url: string; headers: Record<string, string> }, ListModelsError>> {
    if (connection.mode === "cliproxy") {
        // Reuse the SAME `/models` route + bearer auth `resolveModelId` uses, over the owned proxy URL —
        // but UNCACHED (this is a fresh call, not `resolveModelId`'s memoized boot resolution).
        const keyResult = await seams.readProxyKey();
        if (keyResult.isErr()) return err({ type: "key_missing" });
        return ok({ url: `${env.cliproxyApiUrl}/models`, headers: { Authorization: `Bearer ${keyResult.value}` } });
    }
    const key = seams.readModelApiKey(connection.provider);
    if (!key) return err({ type: "key_missing" });
    if (connection.protocol === "anthropic") {
        // The configured `baseURL` is the `/v1`-terminated protocol root — the `@ai-sdk/anthropic`
        // convention the chat path already relies on (it POSTs to `{baseURL}/messages`). Listing derives
        // from that SAME value: `GET {baseURL}/models` (Anthropic's List Models route), with the
        // `x-api-key` + `anthropic-version` headers. One configured URL serves both paths and neither
        // re-derives the other's form, so there is no baseURL that lists but cannot chat (or vice versa).
        return ok({ url: `${connection.baseURL}/models`, headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } });
    }
    // OpenAI-compatible: `GET {baseURL}/models` with bearer auth (the baseURL already carries `/v1` by
    // the OpenAI convention, so it is not re-appended).
    return ok({ url: `${connection.baseURL}/models`, headers: { Authorization: `Bearer ${key}` } });
}

/**
 * List the connection's available model ids for the agent-model picker, UNCACHED. Resolves
 * the configured connection, shapes the mode-specific request (cliproxy `/models`, direct
 * OpenAI-compatible `/models`, direct Anthropic `/models` off the `/v1`-terminated root), and parses the shared `{ data: [{ id }] }`
 * response. Returns the id list, or a {@link ListModelsError} the picker maps to free-text entry — every
 * failure is on the Result channel because listing failure is an ordinary, designed outcome, not a fault.
 */
export async function listConnectionModels(seams: ListModelsSeams = realSeams): Promise<Result<string[], ListModelsError>> {
    const connection = seams.resolveConnection();
    // A malformed `models` block: surface it (same fields boot reports) rather than listing against the
    // silently-substituted default connection.
    if (connection.configError) return err({ type: "connection_invalid", issues: connection.configError.issues });

    const requestResult = await requestFor(connection, seams);
    if (requestResult.isErr()) return err(requestResult.error);
    const { url, headers } = requestResult.value;

    let res: Response;
    // fetch throws on a dead endpoint; bridge that throw into the Result channel.
    try {
        res = await seams.fetch(url, headers);
    } catch (cause) {
        return err({ type: "unreachable", detail: cause instanceof Error ? cause.message : String(cause) });
    }
    if (!res.ok) return err({ type: "unreachable", detail: `HTTP ${res.status}` });
    const models = await res.jsonWith(modelsSchema);
    if (!models || models.data.length === 0) return err({ type: "no_models" });
    return ok(models.data.map((m) => m.id));
}

// Commit-time accessibility validation for the agent-model picker (design D6). Distinct from listing:
// listing shapes a GET the picker turns into rows; this shapes the connection's cheapest "can the
// credential serve THIS id?" check and returns the three-valued verdict the commit decision consumes.
// The cliproxy verdict is delegated verbatim to proxy/models.ts (`checkModelAccess`) — never
// reimplemented here — while the direct-anthropic `count_tokens` request is direct-mode-specific shaping
// that belongs beside `requestFor` (same `x-api-key` + `anthropic-version` headers), with a verdict
// mapping that MUST match `checkModelAccess`'s exactly.

/**
 * Upper bound on a single commit-time accessibility check. The `count_tokens` route is sub-second and
 * unbilled (design D3), so this is the "endpoint accepted the connection then never answered" ceiling —
 * not the expected latency. Matched to the launch probe's timeout discipline (setup.ts `PROBE_TIMEOUT_MS`)
 * so a hung endpoint can never wedge the picker's busy state open indefinitely; a trip past it aborts the
 * request, which the mapping below reads as `inconclusive` (the switch commits, never blocks).
 */
const VALIDATE_TIMEOUT_MS = 10_000;

/**
 * The 404 body an Anthropic `count_tokens` endpoint returns for a model the credential cannot serve —
 * `error.type` is the discriminator. Mirrors the shape `checkModelAccess` (proxy/models.ts) reads on the
 * proxy's 404 so this direct-mode verdict maps identically: only `not_found_error` means "inaccessible",
 * a bare/malformed 404 falls through to inconclusive. `jsonWith` yields null on a shape mismatch, so a
 * malformed body never throws.
 */
const countTokensErrorSchema = z.object({ error: z.object({ type: z.string() }) });

/**
 * The effectful seams for {@link validateModelSelection}, injectable so the per-mode commit validation is
 * unit-testable offline — mirrors {@link ListModelsSeams}. Production callers omit the argument. The
 * cliproxy path delegates verbatim to {@link checkModelAccess} (its own request + verdict mapping), so
 * that is a seam of its own; `fetch` shapes ONLY the direct-anthropic `count_tokens` POST (a full
 * `RequestInit`, not the listing seam's headers-only GET).
 */
export type ValidateSelectionSeams = {
    /** The resolved model connection. Real: {@link resolveModelConnection}. */
    readonly resolveConnection: () => ResolvedModelConnection;
    /** Discover the cliproxy client key from the proxy config. Real: {@link readApiKey}. */
    readonly readProxyKey: () => Promise<Result<string, ChatSetupError>>;
    /** The direct-mode secret for the connection's provider. Real: {@link resolveModelApiKey}. */
    readonly readModelApiKey: (provider: string) => string | undefined;
    /** The cliproxy accessibility verdict — request + mapping owned by proxy/models.ts. Real: {@link checkModelAccess}. */
    readonly checkModelAccess: (apiKey: string, modelId: string, signal?: AbortSignal) => Promise<ModelAccess>;
    /** Issue the direct-anthropic `count_tokens` POST. Real: `fetch`. */
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
};

const realValidateSeams: ValidateSelectionSeams = {
    resolveConnection: resolveModelConnection,
    readProxyKey: readApiKey,
    readModelApiKey: resolveModelApiKey,
    checkModelAccess,
    fetch: (url, init) => fetch(url, init),
};

/**
 * Accessibility-validate a committed model id before the picker persists it, per connection protocol
 * (design D6). Returns the three-valued {@link ModelAccess} the commit decision consumes: `served` and
 * `inconclusive` commit, only a definite `not_found` is rejected in-dialog. Every branch that cannot
 * decide resolves to `inconclusive` — the picker must NEVER lose its switch capability to validation:
 *
 * - **cliproxy** → delegate to {@link checkModelAccess} over the proxy client key (never reimplement the
 *   proxy request or its verdict mapping). A missing proxy key is not a user-facing failure — validation
 *   is simply unavailable → `inconclusive`.
 * - **direct `anthropic`** → POST `{baseURL}/messages/count_tokens` with the same `x-api-key` +
 *   `anthropic-version` headers {@link requestFor} shapes for listing; map EXACTLY as `checkModelAccess`
 *   documents: 200 → `served`, 404 with `error.type === "not_found_error"` → `not_found`, anything else
 *   (throw, abort/timeout, other status, malformed body) → `inconclusive`.
 * - **direct `openai-compatible`** → `inconclusive` with no request: no cheap validation route exists, so
 *   the spec commits the selection as before.
 * - **invalid connection config** → `inconclusive` (boot reports the malformed block; validation never
 *   blocks the switch over it).
 */
export async function validateModelSelection(modelId: string, seams: ValidateSelectionSeams = realValidateSeams): Promise<ModelAccess> {
    const connection = seams.resolveConnection();
    if (connection.configError) return "inconclusive";

    if (connection.mode === "cliproxy") {
        const keyResult = await seams.readProxyKey();
        if (keyResult.isErr()) return "inconclusive";
        return seams.checkModelAccess(keyResult.value, modelId, AbortSignal.timeout(VALIDATE_TIMEOUT_MS));
    }
    // Direct mode: only the Anthropic protocol has the unbilled count_tokens route (design D4); an
    // openai-compatible endpoint has no cheap check, so its selection commits as before.
    if (connection.protocol !== "anthropic") return "inconclusive";
    const key = seams.readModelApiKey(connection.provider);
    if (!key) return "inconclusive";

    let res: Response;
    // fetch throws on a dead endpoint or an aborted/timed-out signal; any throw is inconclusive, so a flaky
    // network commits the switch rather than blocking it (the same inconclusive-accept `checkModelAccess` uses).
    try {
        res = await seams.fetch(`${connection.baseURL}/messages/count_tokens`, {
            method: "POST",
            headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
            body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "ping" }] }),
            signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
        });
    } catch {
        return "inconclusive";
    }
    if (res.ok) return "served";
    if (res.status === 404) {
        const body = await res.jsonWith(countTokensErrorSchema);
        if (body?.error.type === "not_found_error") return "not_found";
    }
    return "inconclusive";
}
