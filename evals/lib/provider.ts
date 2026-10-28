/**
 * The provider of an eval run. By default it is the conversation provider that
 * the CLI configures: the same connection, credential, model, and effort as a
 * chat of the CLI. A JSON file can name a different model, for example in CI,
 * where no CLI configuration exists. The file holds the `AiSdkProviderConfig`
 * of the model under test. The key comes from the file (`apiKey`) or from the
 * environment variable that the file names (`apiKeyEnv`), thus a committed
 * file can hold no secret.
 */

import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { Logger } from "@inflexa-ai/harness/lib/logger.js";
import { resolveAgentEfforts, resolveHarnessConfig, resolveModelConnection } from "../../cli/src/modules/harness/config.ts";
import { agentProviderConfig, buildAuthInjectingFetch, createAgentModelResolver, resolveChatCredential } from "../../cli/src/modules/harness/runtime.ts";
import { resolveModelApiKey } from "../../cli/src/lib/env.ts";
import { readApiKey, resolveModelId } from "../../cli/src/modules/proxy/models.ts";
import { parseJsonAs } from "@inflexa-ai/harness/lib/parse-json.js";
import { createConfiguredAiSdkProvider, type AiSdkProviderConfig } from "@inflexa-ai/harness/providers/ai-sdk.js";
import type { ChatProvider } from "@inflexa-ai/harness/providers/types.js";

const ReasoningSchema = z.enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const ProviderFileSchema = z.object({
    kind: z.enum(["anthropic", "openai", "openai-compatible"]),
    /** The name of an `openai-compatible` endpoint. */
    name: z.string().optional(),
    baseURL: z.string().optional(),
    model: z.string(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    reasoning: ReasoningSchema.optional(),
    maxOutputTokens: z.number().int().positive().optional(),
});

export type ProviderFile = z.infer<typeof ProviderFileSchema>;

/** The model of a run, as the report names it. The key never appears. */
export type ProviderIdentity = Pick<ProviderFile, "kind" | "baseURL" | "model" | "reasoning">;

export function providerConfigOf(file: ProviderFile, env: Readonly<Record<string, string | undefined>>): AiSdkProviderConfig {
    const apiKey = file.apiKey ?? (file.apiKeyEnv === undefined ? undefined : env[file.apiKeyEnv]);
    const common = { model: file.model, reasoning: file.reasoning, maxOutputTokens: file.maxOutputTokens };
    switch (file.kind) {
        case "anthropic":
        case "openai":
            if (apiKey === undefined) throw new Error(`the provider file gives no key: set apiKey, or set apiKeyEnv to a variable that holds the key`);
            return { kind: file.kind, baseURL: file.baseURL, apiKey, ...common };
        case "openai-compatible":
            if (file.baseURL === undefined) throw new Error("an openai-compatible provider needs baseURL");
            return { kind: "openai-compatible", name: file.name ?? "eval", baseURL: file.baseURL, apiKey, ...common };
        default: {
            const unhandled: never = file.kind;
            throw new Error(`unhandled provider kind ${String(unhandled)}`);
        }
    }
}

export async function readProviderFile(path: string): Promise<ProviderFile> {
    return parseJsonAs(await readFile(path, "utf8"), ProviderFileSchema);
}

export function providerOf(file: ProviderFile, env: Readonly<Record<string, string | undefined>>, logger: Logger): ChatProvider {
    return createConfiguredAiSdkProvider({ config: providerConfigOf(file, env), logger });
}

export function identityOf(file: ProviderFile): ProviderIdentity {
    return { kind: file.kind, baseURL: file.baseURL, model: file.model, reasoning: file.reasoning };
}

/** The provider of one agent role as the CLI configures it, and the facts of it that a report names. */
export async function cliProvider(
    logger: Logger,
    role: "conversation" | "sandbox" = "conversation",
): Promise<{ readonly provider: ChatProvider; readonly identity: ProviderIdentity }> {
    const connection = resolveModelConnection();
    if (connection.configError !== undefined) throw new Error(`the models block of the CLI config is not valid: ${connection.configError.issues}`);
    const credential = await resolveChatCredential(connection, { readKey: readApiKey, readModelApiKey: resolveModelApiKey });
    if (credential.isErr()) throw new Error(`the CLI has no chat credential: ${JSON.stringify(credential.error)}`);
    const resolveAgentModel = createAgentModelResolver(connection, resolveHarnessConfig().model, credential.value.apiKey, resolveModelId);
    const model = await resolveAgentModel(role);
    if (model.isErr()) throw new Error(`the CLI resolves no ${role} model: ${JSON.stringify(model.error)}`);
    const effort = resolveAgentEfforts()[role];
    const source = credential.value.source;
    const config = agentProviderConfig({
        connection,
        selection: { model: model.value, effort },
        apiKey: credential.value.apiKey,
        fetch: source === undefined ? undefined : buildAuthInjectingFetch(source),
    });
    return {
        provider: createConfiguredAiSdkProvider({ config, logger }),
        identity: { kind: config.kind, baseURL: config.baseURL, model: config.model, reasoning: config.reasoning },
    };
}
