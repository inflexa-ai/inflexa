import { describe, expect, it } from "bun:test";

import { makeSession } from "./__fixtures__/session.js";
import { createConfiguredAiSdkProvider, type AiSdkProviderConfig } from "./ai-sdk.js";
import type { ChatRequest, ChatStreamEvent, FetchLike } from "./types.js";

const request: ChatRequest = {
    system: "You are a test model.",
    messages: [{ role: "user", content: "hello" }],
    tools: {},
};

/**
 * A model id of the reasoning family. The package matches the id against that
 * family, thus a reasoning-family id keeps the wire shape of a real call.
 */
const MODEL = "gpt-5.1";

/** One entry of the `input` array of a Responses request. */
interface ResponsesInputItem {
    readonly type?: string;
    readonly id?: string;
    readonly encrypted_content?: string;
}

/** The fields of a Responses request body that these tests read. */
interface ResponsesRequestBody {
    readonly model?: string;
    readonly store?: boolean;
    readonly user?: string;
    readonly max_output_tokens?: number;
    readonly input?: readonly ResponsesInputItem[];
}

/**
 * Record each outbound request body, then answer with `respond`. The body holds
 * the retention directive and the input items, thus a test reads the recorded
 * value instead of the model call.
 */
function capturingFetch(respond: () => Response): { readonly fetch: FetchLike; readonly bodies: ResponsesRequestBody[] } {
    const bodies: ResponsesRequestBody[] = [];
    const fetch: FetchLike = (_input, init) => {
        bodies.push(init?.body === undefined || init.body === null ? {} : (JSON.parse(String(init.body)) as ResponsesRequestBody));
        return Promise.resolve(respond());
    };
    return { fetch, bodies };
}

/** Build an `openai` arm config over a stubbed wire, with the fields of one test. */
function openaiArm(fetch: FetchLike, opts: { store?: boolean; maxRetries?: number; maxOutputTokens?: number } = {}): AiSdkProviderConfig {
    return {
        kind: "openai",
        apiKey: "test-key",
        model: MODEL,
        fetch,
        ...(opts.store !== undefined ? { store: opts.store } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
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
            resolveBilling: async () => ({}),
        });

        expect(provider.capabilities.imageToolResults).toBe(true);
    });

    it("leaves the picture capability absent for a custom endpoint", () => {
        const provider = createConfiguredAiSdkProvider({
            config: { kind: "openai", baseURL: "http://models.local/v1", apiKey: "test-key", model: MODEL },
            resolveBilling: async () => ({}),
        });

        expect(provider.capabilities.imageToolResults).toBeUndefined();
    });

    it("honors the config over the endpoint default in both directions", () => {
        const refused = createConfiguredAiSdkProvider({
            config: { kind: "openai", apiKey: "test-key", model: MODEL, capabilities: { imageToolResults: false } },
            resolveBilling: async () => ({}),
        });
        const declared = createConfiguredAiSdkProvider({
            config: {
                kind: "openai",
                baseURL: "http://models.local/v1",
                apiKey: "test-key",
                model: MODEL,
                capabilities: { imageToolResults: true },
            },
            resolveBilling: async () => ({}),
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
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch), resolveBilling: async () => ({}) });

        const reply = (await provider.chat(request, makeSession()))._unsafeUnwrap();

        // The text part also carries the provider-scoped item id, thus the match
        // reads a subset of the part.
        expect(reply.message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Hello, world" }] });
        expect(reply.usage?.inputTokens).toBe(1_200);
        expect(reply.usage?.outputTokens).toBe(90);
        expect(reply.usage?.cacheReadInputTokens).toBe(900);
        expect(reply.usage?.reasoningTokens).toBe(64);
    });
});

describe("openai arm stream", () => {
    it("yields the text deltas and one terminal event that carries the usage", async () => {
        const cap = capturingFetch(() => responsesSse(["Hel", "lo"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch), resolveBilling: async () => ({}) });

        const events: ChatStreamEvent[] = [];
        for await (const event of provider.chatStream(request, makeSession())) events.push(event);

        expect(events.slice(0, 2)).toEqual([
            { type: "text-delta", text: "Hel" },
            { type: "text-delta", text: "lo" },
        ]);
        const done = events.at(-1);
        if (done?.type !== "done") throw new Error(`expected a terminal done event, got ${done?.type}`);
        expect(events).toHaveLength(3);
        expect(done.response.message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Hello" }] });
        expect(done.response.usage?.cacheReadInputTokens).toBe(900);
        expect(done.response.usage?.reasoningTokens).toBe(64);
    });
});

describe("openai arm stream failure", () => {
    it("surfaces a classified provider error for an error event", async () => {
        // A backend that reports a failure mid-stream fails loud on the error
        // channel, and it never reads as an empty turn.
        const cap = capturingFetch(() => responsesErrorSse("upstream exploded"));
        const provider = createConfiguredAiSdkProvider({
            config: openaiArm(cap.fetch, { maxRetries: 0 }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("provider");
            expect(result.error.message).toContain("upstream exploded");
        }
    });
});

describe("openai arm store directive", () => {
    it("sends store false when the config declares no value", async () => {
        // An unset value lets the server keep the response, and it makes the
        // package emit an item reference for a round-tripped item.
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch), resolveBilling: async () => ({}) });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(cap.bodies[0]?.store).toBe(false);
    });

    it("sends store true when the config declares it", async () => {
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch, { store: true }), resolveBilling: async () => ({}) });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(cap.bodies[0]?.store).toBe(true);
    });

    it("keeps the other provider options beside the store value", async () => {
        // The cache namespace of a different vendor is inert on this wire, thus
        // the `user` key carries the proof: the merge adds, and it does not
        // replace.
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch), resolveBilling: async () => ({}) });

        const result = await provider.chat(
            {
                ...request,
                providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } }, openai: { user: "user-001" } },
            },
            makeSession(),
        );

        expect(result.isOk()).toBe(true);
        expect(cap.bodies[0]?.store).toBe(false);
        expect(cap.bodies[0]?.user).toBe("user-001");
    });
});

describe("openai arm output ceiling", () => {
    it("sends no ceiling when the config names none", async () => {
        // The package puts a ceiling on the wire as it is. A shared default above
        // the cap of the model fails each call, thus the arm sends none and the
        // server holds the reply at the cap.
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch), resolveBilling: async () => ({}) });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(cap.bodies[0]).not.toHaveProperty("max_output_tokens");
    });

    it("sends the ceiling that the config names", async () => {
        const cap = capturingFetch(() => responsesSse(["Hello, world"]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch, { maxOutputTokens: 4_096 }), resolveBilling: async () => ({}) });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(cap.bodies[0]?.max_output_tokens).toBe(4_096);
    });
});

describe("openai arm encrypted reasoning", () => {
    it("replays the encrypted content of a stored reasoning part onto the reasoning input item", async () => {
        // The stateless path of the package captures the blob in the
        // provider-scoped options of a reasoning part. A later turn hands the
        // same history back, and the blob must reach the wire again.
        const cap = capturingFetch(() => responsesSse(["The second answer."]));
        const provider = createConfiguredAiSdkProvider({ config: openaiArm(cap.fetch), resolveBilling: async () => ({}) });

        const result = await provider.chat(
            {
                system: "You are a test model.",
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
                tools: {},
            },
            makeSession(),
        );

        expect(result.isOk()).toBe(true);
        const reasoningItem = cap.bodies[0]?.input?.find((item) => item.type === "reasoning");
        expect(reasoningItem?.id).toBe("rs_test_1");
        expect(reasoningItem?.encrypted_content).toBe("encrypted-blob-1");
    });
});
