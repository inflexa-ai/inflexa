import { describe, expect, test } from "bun:test";

import type { Config } from "../../lib/config.ts";
import { resolveEmbedder } from "./resolve.ts";

// A minimal Config base — only `embedding` varies per test; the rest are
// defaulted to satisfy the type without exercising unrelated schema fields.
function baseConfig(embedding: Config["embedding"]): Config {
    return { telemetry: false, theme: "tokyo-night", runtime: "docker", leaderTimeout: 2000, embedding };
}

// `.match` is one of the neverthrow must-use-result rule's recognized handlers
// (`match`/`unwrapOr`/`_unsafeUnwrap`); it lets us assert on the error branch
// without throwing, and keeps the lint rule satisfied.
describe("resolveEmbedder", () => {
    test("off mode → err embeddings_not_configured", () => {
        const outcome = resolveEmbedder(baseConfig({ mode: "off" })).match(
            () => "ok" as const,
            (e) => e.type,
        );
        expect(outcome).toBe("embeddings_not_configured");
    });

    test("local mode with modelPath → ok provider", () => {
        const provider = resolveEmbedder(baseConfig({ mode: "local", modelPath: "/some/model.gguf" })).match(
            (p) => p,
            () => null,
        );
        expect(provider).not.toBeNull();
        expect(typeof provider!.embed).toBe("function");
    });

    test("local mode without modelPath → err local_model_missing", () => {
        const outcome = resolveEmbedder(baseConfig({ mode: "local" })).match(
            () => "ok" as const,
            (e) => e.type,
        );
        expect(outcome).toBe("local_model_missing");
    });

    test("api-key mode with apiKey → ok provider", () => {
        const provider = resolveEmbedder(baseConfig({ mode: "api-key", apiKey: "sk-test" })).match(
            (p) => p,
            () => null,
        );
        expect(provider).not.toBeNull();
        expect(typeof provider!.embed).toBe("function");
    });

    test("api-key mode without apiKey → err api_key_missing", () => {
        const outcome = resolveEmbedder(baseConfig({ mode: "api-key" })).match(
            () => "ok" as const,
            (e) => e.type,
        );
        expect(outcome).toBe("api_key_missing");
    });
});
