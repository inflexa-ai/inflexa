import { type Result, ok, err } from "neverthrow";
import { z } from "zod";

import { env } from "../../lib/env.ts";

// CLIProxyAPI (provisioned by `inflexa setup`) exposes an OpenAI-compatible endpoint that routes to
// whichever provider was authenticated. These helpers cover the proxy-endpoint concerns a model caller
// must settle before it can stream: discovering the client API key we baked into the proxy config at
// setup, and electing a default model from the proxy's live `/models` list. Election is a deterministic
// rank (family preference, then recency) walked against the proxy's unbilled `count_tokens` route: the
// advertised list is the proxy's GitHub-sourced registry, not the credential, so some ids answer 404 on
// use — the walk skips those a definite not-found rules out so a model the credential cannot serve is
// never elected while a serviceable one remains. The endpoint and config path are the single source of
// truth in env.ts (`cliproxyApiUrl`, `cliproxyConfigPath`) — not user-overridable, since we own the
// container.

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string(), created: z.number().optional() })) });

/**
 * One entry of the proxy's `/models` list as the ranking consumes it: the id plus the registry's
 * `created` unix timestamp (verified live: the proxy passes it through from its GitHub-sourced
 * registry). `created` is optional so a proxy build that omits it degrades to the id tiebreak —
 * still deterministic — rather than failing the schema.
 */
export type ModelCandidate = { id: string; created?: number };

/**
 * The model families CLIProxyAPI can serve (one per authenticatable account kind), in default-pick
 * preference order, each paired with the vendor slug that names its provider. The `provider` column
 * is read in ONE direction only — provider→family, by {@link modelMatchesProvider} — both as a cliproxy
 * auto-resolve sanity check and to recognize the claude family the election validates. It MUST NEVER be
 * read id→provider to derive a provider identity: the connection's configured `provider` is the sole
 * identity source, and deriving one from a model id here would fabricate provenance. The `family` column
 * feeds {@link rankModelCandidates}.
 */
const MODEL_FAMILIES = [
    { family: "claude", provider: "anthropic" },
    { family: "gpt", provider: "openai" },
    { family: "gemini", provider: "google" },
    { family: "qwen", provider: "qwen" },
] as const;

/**
 * Family preference for the default-model rank (claude > gpt > gemini > qwen), the `family` column of
 * {@link MODEL_FAMILIES}. The user primarily uses Anthropic, so a Claude model is preferred when the
 * authenticated account serves one, then the other known families, then — when none match — the whole
 * list by recency. This keeps the default adapting to whatever `inflexa setup` signed into with no
 * baked-in per-model knowledge. {@link rankModelCandidates} consumes it.
 */
const MODEL_PREFERENCE = MODEL_FAMILIES.map((f) => f.family);
let cachedModelId: string | null = null;

/** Setup failures surfaced before streaming begins — the proxy key is missing, unreachable, or reports no models. */
export type ChatSetupError = { type: "proxy_key_missing" } | { type: "proxy_unreachable"; detail: string } | { type: "no_models" };

/** The proxy requires the client API key we generated into its config at setup. */
export async function readApiKey(): Promise<Result<string, ChatSetupError>> {
    const text = await Bun.file(env.cliproxyConfigPath)
        .text()
        .catch(() => "");
    const key = text.match(/^api-keys:\s*\n\s*-\s*"([^"]+)"/m)?.[1];
    if (!key) return err({ type: "proxy_key_missing" });
    return ok(key);
}

/**
 * Resolve the default chat model from the proxy's `/models`, cached per process. Ranks the listing
 * deterministically ({@link rankModelCandidates}), then walks the candidates to elect one the credential
 * can actually serve: a claude-family candidate is validated via {@link checkModelAccess} and elected on
 * `served` or `inconclusive` — only a definite `not_found` advances to the next; a non-claude-family
 * candidate is elected by rank alone (no cheap validation route exists for it). If every candidate is
 * `not_found`, the top-ranked one is elected unvalidated so the launch probe's completion request — not
 * the election — surfaces the failure: the election never invents a new way for launch to block. The
 * elected winner is cached so every consumer of the auto default in this process (launch probe, harness
 * boot's per-agent fallback) observes the same id without re-walking.
 *
 * `signal` bounds the round-trips for callers that cannot afford to wait on a proxy that accepts the
 * connection and then never answers — the launch-time credential probe, which would otherwise hold the
 * terminal indefinitely. The one signal bounds the `/models` fetch and every validation request in the
 * walk (a shared deadline over the whole election). It is optional because the chat path resolves lazily
 * behind a UI that can already be cancelled, and imposing a deadline on it would only invent a new
 * failure mode.
 */
export async function resolveModelId(apiKey: string, signal?: AbortSignal): Promise<Result<string, ChatSetupError>> {
    if (cachedModelId) return ok(cachedModelId);
    const candidates = await listModelCandidates(apiKey, signal);
    if (candidates.isErr()) return err(candidates.error);
    cachedModelId = await electModel(rankModelCandidates(candidates.value), apiKey, signal);
    return ok(cachedModelId);
}

/**
 * Fetch and parse the proxy's `/models` list into its raw candidate pool — the single fetch both the
 * election ({@link resolveModelId}) and the setup accessibility sweep consume, so the GET + schema parse
 * lives in one place. The error semantics are exactly the ones the election carried inline before, so its
 * callers are unaffected: a fetch throw (dead endpoint or aborted `signal`) or a non-200 bridges into
 * `proxy_unreachable`, and an empty or schema-mismatched body (`jsonWith` yields null, never a throw) into
 * `no_models`. `signal` bounds the round-trip for callers that cannot wait on a proxy that accepts the
 * connection and then never answers (the launch probe); it is optional for the lazy chat path.
 */
export async function listModelCandidates(apiKey: string, signal?: AbortSignal): Promise<Result<ModelCandidate[], ChatSetupError>> {
    let res: Response;
    // fetch throws on a dead endpoint (or an aborted signal); bridge that throw into the Result channel.
    try {
        res = await fetch(`${env.cliproxyApiUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    } catch (cause) {
        return err({ type: "proxy_unreachable", detail: cause instanceof Error ? cause.message : String(cause) });
    }
    if (!res.ok) return err({ type: "proxy_unreachable", detail: `HTTP ${res.status}` });
    const models = await res.jsonWith(modelsSchema);
    if (!models || models.data.length === 0) return err({ type: "no_models" });
    return ok(models.data);
}

/**
 * Walk the ranked candidates to the first the credential can serve. Claude-family ids are validated with
 * {@link checkModelAccess} — only a definite `not_found` is walked past, while `served`/`inconclusive`
 * elect (a flaky check must not walk past the best candidate). Non-claude-family ids elect by rank alone:
 * `count_tokens` is Anthropic-protocol and only verified through the proxy for claude ids. When every
 * candidate is `not_found`, the top-ranked id is returned unvalidated so downstream probe reporting — not
 * the election — surfaces the failure. Claude-family membership comes from {@link modelMatchesProvider}
 * (provider→family via {@link MODEL_FAMILIES}'s anthropic row), never an id→provider derivation.
 */
async function electModel(ranked: string[], apiKey: string, signal?: AbortSignal): Promise<string> {
    for (const id of ranked) {
        if (!modelMatchesProvider("anthropic", id)) return id;
        if ((await checkModelAccess(apiKey, id, signal)) !== "not_found") return id;
    }
    // `ranked` is non-empty: resolveModelId returns `no_models` before calling this on an empty list, and
    // rankModelCandidates preserves every id, so the top-ranked candidate always exists here.
    return ranked[0]!;
}

/**
 * Test hook: forget the process-wide model cache. Test-only — the cache is deliberately never
 * invalidated at runtime (a proxy's model list changes only across a `inflexa setup`, which restarts
 * the process), so without this every test after the first would observe the first one's resolution.
 */
export function __resetModelCacheForTest(): void {
    cachedModelId = null;
}

/**
 * Rank a `/models` listing into the deterministic default-model order, as a TOTAL order: the same set in
 * any serving order yields the identical sequence. Candidates of the FIRST {@link MODEL_PREFERENCE}
 * family with any match (case-insensitive substring) rank first, ordered by `created` descending — a
 * missing `created` ranks oldest, ties break by id ascending. When no family matches, that same recency
 * order applies to the whole list. Recency (never lexicographic id order) is the primary sort: ascending
 * byte order would rank dated legacy ids (`claude-3-5-…`) first and deterministically elect a stale
 * model. The election walk and setup's model list both consume the ranked ids.
 *
 * Load-bearing on WHY the blind first-family scan is correct: the cliproxy `/models` this consumes is
 * already scoped by the proxy to the AUTHENTICATED account's provider — verified live, an Anthropic proxy
 * lists only claude ids, never the gpt/gemini/qwen/… families its GitHub registry also carries. So the
 * FIRST matching family IS the account's family; `MODEL_PREFERENCE` is not a cross-provider filter (it
 * only breaks the rare tie of several credentials loaded into one proxy at once — and a wrong-family
 * election there is caught loudly by boot's provider-family guard, {@link modelMatchesProvider} in
 * `harness/runtime.ts`, as `model_provider_mismatch`, never served as a silent 404). This is why setup's
 * `modelMatchesProvider` post-filter is a belt-and-braces no-op in practice, not the thing that selects
 * the family.
 */
export function rankModelCandidates(models: ModelCandidate[]): string[] {
    const family = MODEL_PREFERENCE.find((fam) => models.some((m) => m.id.toLowerCase().includes(fam)));
    const pool = family ? models.filter((m) => m.id.toLowerCase().includes(family)) : models;
    // Copy before sorting: the no-family branch aliases the caller's array, and rank must never mutate it.
    return [...pool].sort(byRecencyThenId).map((m) => m.id);
}

/**
 * Total-order comparator for the default-model rank: `created` descending (a missing timestamp ranks
 * oldest — 0 precedes every real unix stamp), ties broken by id ascending so the sort is stable across
 * serving orders. Id order is ONLY ever the tiebreak, never the primary key.
 */
function byRecencyThenId(a: ModelCandidate, b: ModelCandidate): number {
    const byCreated = (b.created ?? 0) - (a.created ?? 0);
    if (byCreated !== 0) return byCreated;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The 404 body the proxy forwards for a model the credential cannot serve; `error.type` is the discriminator. */
const countTokensErrorSchema = z.object({ error: z.object({ type: z.string() }) });

/**
 * The accessibility verdict for one model, three-valued by design — all three are EXPECTED outcomes, not
 * errors, which is why {@link checkModelAccess} returns this plain union rather than a `Result`: no branch
 * is a fault to propagate. `served` — the credential can use the model; `not_found` — the credential
 * definitively cannot (the only verdict that advances the election walk); `inconclusive` — the check
 * itself could not decide, so the election accepts the candidate rather than walking past the best one on
 * a flaky signal.
 */
export type ModelAccess = "served" | "not_found" | "inconclusive";

/**
 * Ask the proxy whether the authenticated credential can serve `modelId`, via the unbilled `count_tokens`
 * route (verified live against the fork: the proxy forwards it upstream with the real credential — an
 * inaccessible model answers 404 `not_found_error`, an accessible one 200 — and Anthropic does not bill
 * it). Returns a three-valued {@link ModelAccess}, never a Result, because every outcome is a normal
 * verdict rather than a failure.
 *
 * The body discrimination is load-bearing: a proxy fork that does not route `count_tokens` at all would
 * 404 EVERY request, so a bare 404 must read as `inconclusive` (degrade to rank-only election) — only a
 * 404 carrying `error.type === "not_found_error"` means "this model is inaccessible". Any throw (fetch
 * failure, or an aborted/timed-out `signal`) is likewise inconclusive. `jsonWith` yields null on a body
 * shape mismatch, so a malformed 404 body never throws — it falls through to inconclusive.
 *
 * Headers are deliberately the `/models` route's (`Authorization: Bearer` with the proxy client key,
 * no `anthropic-version`) rather than the `x-api-key` style the chat POST uses: verified live — the
 * proxy authenticates the client key and injects the provider-side headers upstream itself. If a
 * future fork build demanded more here, every verdict would become inconclusive, which by design
 * degrades election to rank-only and silences stale-pin warnings rather than misreporting anything.
 */
export async function checkModelAccess(apiKey: string, modelId: string, signal?: AbortSignal): Promise<ModelAccess> {
    let res: Response;
    try {
        res = await fetch(`${env.cliproxyApiUrl}/messages/count_tokens`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "ping" }] }),
            signal,
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

/**
 * True when `modelId`'s family matches the configured provider slug — the cliproxy auto-resolve
 * agreement guard, and the claude-family test the election uses. Reads {@link MODEL_FAMILIES} in the
 * provider→family direction ONLY: the configured provider names one or more families, and the id must
 * contain one of them (case-insensitive substring, same mechanics as {@link rankModelCandidates}). This
 * is NOT id→provider derivation — it never produces a provider identity, only answers "is this the family
 * I expected for the configured provider?". A configured provider absent from the table (e.g. `deepseek`
 * in cliproxy mode) matches nothing, so it is treated as a mismatch — boot then surfaces an actionable
 * error rather than serving a model the route was not built for. With the default provider `anthropic`,
 * only Claude-family ids pass — the sole family that table maps to `anthropic`.
 */
export function modelMatchesProvider(provider: string, modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return MODEL_FAMILIES.some((f) => f.provider === provider && lower.includes(f.family));
}
