import { type Result, ok, err } from "neverthrow";
import { z } from "zod";

import { env } from "../../lib/env.ts";

// CLIProxyAPI (provisioned by `inflexa setup`) exposes an OpenAI-compatible endpoint that routes to
// whichever provider was authenticated. These helpers cover the two proxy-endpoint concerns a model
// caller must settle before it can stream: discovering the client API key we baked into the proxy
// config at setup, and resolving/ranking a default model from the proxy's live `/models` list. The
// endpoint and config path are the single source of truth in env.ts (`cliproxyApiUrl`,
// `cliproxyConfigPath`) — not user-overridable, since we own the container.

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/**
 * Resolved once per process from the proxy's model list (which reflects the
 * authenticated provider). The user primarily uses Anthropic, so prefer a
 * Claude model when present, then other known families, then whatever is first
 * — this keeps the default adapting to whatever `inflexa setup` signed into.
 */
const MODEL_PREFERENCE = ["claude", "gpt", "gemini", "qwen"];
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

/** Resolve the default chat model from the proxy's `/models`, cached per process. */
export async function resolveModelId(apiKey: string): Promise<Result<string, ChatSetupError>> {
    if (cachedModelId) return ok(cachedModelId);
    let res: Response;
    // fetch throws on a dead endpoint; bridge that throw into the Result channel.
    try {
        res = await fetch(`${env.cliproxyApiUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (cause) {
        return err({ type: "proxy_unreachable", detail: cause instanceof Error ? cause.message : String(cause) });
    }
    if (!res.ok) return err({ type: "proxy_unreachable", detail: `HTTP ${res.status}` });
    const models = await res.jsonWith(modelsSchema);
    if (!models || models.data.length === 0) return err({ type: "no_models" });
    cachedModelId = pickDefaultModel(models.data.map((m) => m.id));
    return ok(cachedModelId);
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
 * Pick the default model id by {@link MODEL_PREFERENCE} (claude > gpt > gemini > qwen, matched
 * case-insensitively by substring), falling back to the first id when no family matches.
 */
export function pickDefaultModel(ids: string[]): string {
    for (const family of MODEL_PREFERENCE) {
        const match = ids.find((id) => id.toLowerCase().includes(family));
        if (match) return match;
    }
    // Callers pass a non-empty list (resolveModelId returns `no_models` first on an empty `data`),
    // so index 0 is always present in practice.
    return ids[0]!;
}
