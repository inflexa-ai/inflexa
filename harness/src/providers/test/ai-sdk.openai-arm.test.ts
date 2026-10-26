import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { streamText, type LanguageModelUsage, type ModelMessage, type SystemModelMessage } from "ai";
import { z } from "zod";

import type { AgentSession } from "../../auth/types.js";
import { parseJsonAs } from "../../lib/parse-json.js";
import { textOf } from "../../lib/unknown-text.js";
import { makeSession } from "../__fixtures__/session.js";
import { createConfiguredAiSdkProvider, toChatUsage, type AiSdkProviderConfig } from "../ai-sdk.js";
import { findProviderError, type ProviderError } from "../errors.js";
import { DEFAULT_PROMPT_CACHE, withPromptCacheBreakpoint, withSystemPromptBreakpoint } from "../prompt-cache.js";
import type { ChatProvider } from "../types.js";

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
function fetchDouble(run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

const MESSAGES: ModelMessage[] = [{ role: "user", content: "hello" }];

type DriveCall = {
    readonly session?: AgentSession;
    readonly live?: boolean;
    readonly instructions?: string | SystemModelMessage;
    readonly messages?: ModelMessage[];
};

/** What a reader of one model call saw. */
type Outcome = {
    readonly deltas: readonly string[];
    readonly text: string;
    /** The first failure that the call reported, as the AI SDK gave it. */
    readonly failure: unknown;
    readonly usage?: LanguageModelUsage;
};

/** Run one model call over the bound model of `provider`, the same way the loop runs each request. */
async function drive(provider: ChatProvider, call: DriveCall = {}): Promise<Outcome> {
    const bound = provider.bind({ session: call.session ?? makeSession(), live: call.live ?? false });
    let failure: unknown;
    const result = streamText({
        model: bound.model,
        ...bound.settings,
        maxRetries: 0,
        instructions: call.instructions ?? "You are a test model.",
        messages: call.messages ?? MESSAGES,
        onError: ({ error }) => {
            failure ??= error;
        },
    });
    const deltas: string[] = [];
    let usage: LanguageModelUsage | undefined;
    for await (const part of result.stream) {
        if (part.type === "text-delta") deltas.push(part.text);
        else if (part.type === "finish-step") usage = part.usage;
    }
    return { deltas, text: deltas.join(""), failure, usage };
}

/** The classified failure of a call that the retry envelope gave up on. */
function providerErrorOf(outcome: Outcome): ProviderError {
    const error = findProviderError(outcome.failure);
    if (error === undefined) throw new Error(`expected a provider error, got ${textOf(outcome.failure)}`, { cause: outcome.failure });
    return error;
}

/**
 * A model id of the reasoning family. The package matches the id against that
 * family, thus a reasoning-family id keeps the wire shape of a real call.
 */
const MODEL = "gpt-5.1";

/** The fields of a Responses request body that these tests read. */
const ResponsesInputItemSchema = z.looseObject({ type: z.string().optional() });

const ResponsesRequestBodySchema = z.looseObject({
    model: z.string().optional(),
    store: z.boolean().optional(),
    prompt_cache_key: z.string().optional(),
    max_output_tokens: z.number().optional(),
    input: z.array(ResponsesInputItemSchema).optional(),
});
type ResponsesRequestBody = z.infer<typeof ResponsesRequestBodySchema>;

/**
 * Record each outbound request body, then answer with `respond`. The body holds
 * the retention directive and the input items, thus a test reads the recorded
 * value instead of the model call.
 */
function capturingFetch(respond: () => Response): { readonly fetch: typeof fetch; readonly bodies: ResponsesRequestBody[] } {
    const bodies: ResponsesRequestBody[] = [];
    const fetch = fetchDouble((_input, init) => {
        bodies.push(
            init?.body === undefined || init.body === null
                ? {}
                : ResponsesRequestBodySchema.parse(parseJsonAs(typeof init.body === "string" ? init.body : "{}", z.json())),
        );
        return Promise.resolve(respond());
    });
    return { fetch, bodies };
}

/** Build an `openai` arm config over a stubbed wire, with the fields of one test. */
function openaiArm(fetch: typeof globalThis.fetch, opts: { store?: boolean; maxRetries?: number; maxOutputTokens?: number } = {}): AiSdkProviderConfig {
    return {
        kind: "openai",
        apiKey: "test-key",
        model: MODEL,
        fetch,
        store: opts.store,
        maxRetries: opts.maxRetries,
        maxOutputTokens: opts.maxOutputTokens,
    };
}

/**
 * The usage block of a Responses reply. The wire nests the cache count and the
 * reasoning count one level under the two totals.
 */
const RESPONSES_USAGE = {
    input_tokens: 1_200,
    input_tokens_details: { cached_tokens: 900 },
    output_tokens: 90,
    output_tokens_details: { reasoning_tokens: 64 },
};

/** One event of the Responses event stream. */
function sseEvent(event: object): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}

/** A Responses event stream that carries the deltas of one message and the usage. */
function responsesSse(deltas: readonly string[]): Response {
    const body = [
        sseEvent({ type: "response.created", response: { id: "resp_test_1", created_at: 1_700_000_000, model: MODEL } }),
        sseEvent({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test_1" } }),
        ...deltas.map((delta) => sseEvent({ type: "response.output_text.delta", item_id: "msg_test_1", output_index: 0, delta })),
        sseEvent({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_test_1" } }),
        sseEvent({ type: "response.completed", response: { usage: RESPONSES_USAGE } }),
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A Responses event stream that reports a failure instead of a turn. */
function responsesErrorSse(message: string): Response {
    return new Response(
        [
            sseEvent({ type: "response.created", response: { id: "resp_test_1", created_at: 1_700_000_000, model: MODEL } }),
            sseEvent({ type: "error", code: "server_error", message, sequence_number: 1 }),
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

describe("openai arm capability default", () => {
    // The picture flag is a fact about the endpoint, not about the dialect. An
    // absent flag means "cannot carry", thus the loop degrades to text.
    it("asserts the picture capability for the default endpoint", () => {
        const provider = createConfiguredAiSdkProvider({
            config: { kind: "openai", apiKey: "test-key", model: MODEL },
        });

        expect(provider.capabilities.imageToolResults).toBe(true);
    });

    it("leaves the picture capability absent for a custom endpoint", () => {
        const provider = createConfiguredAiSdkProvider({
            config: { kind: "openai", baseURL: "http://models.local/v1", apiKey: "test-key", model: MODEL },
        });

        expect(provider.capabilities.imageToolResults).toBeUndefined();
    });

    it("honors the config over the endpoint default in both directions", () => {
        const refused = createConfiguredAiSdkProvider({
            config: { kind: "openai", apiKey: "test-key", model: MODEL, capabilities: { imageToolResults: false } },
        });
        const declared = createConfiguredAiSdkProvider({
            config: {
                kind: "openai",
                baseURL: "http://models.local/v1",
                apiKey: "test-key",
                model: MODEL,
                capabilities: { imageToolResults: true },
            },
        });

        expect(refused.capabilities.imageToolResults).toBe(false);
        expect(declared.capabilities.imageToolResults).toBe(true);
    });
});

describe("openai arm usage", () => {
    it("lands the cached and the reasoning counts of the Responses wire on the neutral fields", async () => {
        // The arm owns no usage mapping. The package normalizes the two nested
        // wire counts, and the shared runtime copies them onto `ChatUsage`.
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch) });

        const outcome = await drive(provider);
        const usage = toChatUsage(outcome.usage);

        expect(outcome.text).toBe("Hello, world");
        expect(usage?.inputTokens).toBe(1_200);
        expect(usage?.outputTokens).toBe(90);
        expect(usage?.cacheReadInputTokens).toBe(900);
        expect(usage?.reasoningTokens).toBe(64);
    });
});

describe("openai arm stream", () => {
    it("streams the text deltas of a live call, and the usage of the reply", async () => {
        const cap = capturingFetch(() => responsesSse(["Hel", "lo"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch) });

        const outcome = await drive(provider, { live: true });

        expect(outcome.failure).toBeUndefined();
        expect(outcome.deltas).toEqual(["Hel", "lo"]);
        expect(toChatUsage(outcome.usage)?.cacheReadInputTokens).toBe(900);
        expect(toChatUsage(outcome.usage)?.reasoningTokens).toBe(64);
    });
});

describe("openai arm stream failure", () => {
    it("surfaces a classified provider error for an error event", async () => {
        // A backend that reports a failure mid-stream fails loud on the error
        // channel, and it never reads as an empty turn.
        const cap = capturingFetch(() => responsesErrorSse("upstream exploded"));
        const provider = createConfiguredAiSdkProvider({
            config: openaiArm(cap.fetch, { maxRetries: 0 }),
        });

        const failure = providerErrorOf(await drive(provider));

        expect(failure.type).toBe("provider");
        expect(failure.message).toContain("upstream exploded");
    });
});

describe("openai arm store directive", () => {
    it("sends store false when the config declares no value", async () => {
        // An unset value lets the server keep the response, and it makes the
        // package emit an item reference for a round-tripped item.
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch) });

        const outcome = await drive(provider);

        expect(outcome.failure).toBeUndefined();
        expect(cap.bodies[0]?.store).toBe(false);
    });

    it("sends store true when the config declares it", async () => {
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch, { store: true }) });

        const outcome = await drive(provider);

        expect(outcome.failure).toBeUndefined();
        expect(cap.bodies[0]?.store).toBe(true);
    });

    it("keeps the other provider options beside the store value", async () => {
        // The session key rides the `openai` namespace, proving merge-not-replace.
        // Other vendors' cache markers ride the system prompt/messages, inert here.
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch, { store: true }) });

        const outcome = await drive(provider, {
            instructions: withSystemPromptBreakpoint("You are a test model.", DEFAULT_PROMPT_CACHE),
            messages: [...withPromptCacheBreakpoint(MESSAGES, DEFAULT_PROMPT_CACHE)],
            session: makeSession({ scope: { kind: "analysis", analysisId: "a1", threadId: "t1" } }),
        });

        expect(outcome.failure).toBeUndefined();
        expect(cap.bodies[0]?.store).toBe(true);
        expect(cap.bodies[0]?.prompt_cache_key).toBe(createHash("sha256").update("a1:t1").digest("base64url"));
        expect(JSON.stringify(cap.bodies[0])).not.toContain("cache_control");
        expect(JSON.stringify(cap.bodies[0])).not.toContain("cachePoint");
    });

    it("keeps the session key beside the store value", async () => {
        // The session key and the store directive share the `openai` namespace.
        // The directive merges into that namespace, thus the key stays.
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch) });

        const outcome = await drive(provider, { session: makeSession({ scope: { kind: "analysis", analysisId: "a1", threadId: "t1" } }) });

        expect(outcome.failure).toBeUndefined();
        expect(cap.bodies[0]?.store).toBe(false);
        expect(cap.bodies[0]?.prompt_cache_key).toBe(createHash("sha256").update("a1:t1").digest("base64url"));
    });
});

describe("openai arm output ceiling", () => {
    it("sends no ceiling when the config names none", async () => {
        // The package puts a ceiling on the wire as it is. A shared default above
        // the cap of the model fails each call, thus the arm sends none and the
        // server holds the reply at the cap.
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch) });

        const outcome = await drive(provider);

        expect(outcome.failure).toBeUndefined();
        expect(cap.bodies[0]).not.toHaveProperty("max_output_tokens");
    });

    it("sends the ceiling that the config names", async () => {
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch, { maxOutputTokens: 4_096 }) });

        const outcome = await drive(provider);

        expect(outcome.failure).toBeUndefined();
        expect(cap.bodies[0]?.max_output_tokens).toBe(4_096);
    });
});

describe("openai arm encrypted reasoning", () => {
    it("replays the encrypted content of a stored reasoning part onto the reasoning input item", async () => {
        // The stateless path of the package captures the blob in the
        // provider-scoped options of a reasoning part. A later turn hands the
        // same history back, and the blob must reach the wire again.
        const cap = capturingFetch(() => responsesSse(["The second answer."]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch) });

        const outcome = await drive(provider, {
            messages: [
                { role: "user", content: "the first question" },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "reasoning",
                            text: "The model thought.",
                            providerOptions: { openai: { itemId: "rs_test_1", reasoningEncryptedContent: "encrypted-blob-1" } },
                        },
                        { type: "text", text: "The first answer." },
                    ],
                },
                { role: "user", content: "the second question" },
            ],
        });

        expect(outcome.failure).toBeUndefined();
        const reasoningItem = cap.bodies[0]?.input?.find((item) => item.type === "reasoning");
        expect(reasoningItem?.id).toBe("rs_test_1");
        expect(reasoningItem?.encrypted_content).toBe("encrypted-blob-1");
    });
});
