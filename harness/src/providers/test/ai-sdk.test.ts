// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the unpadded base64url digest of the session key, whose shape is a pattern
const BASE64URL_DIGEST_43 = /^[A-Za-z0-9_-]{43}$/;

import { errorMessageOf } from "../../lib/thrown.js";
import { textOf } from "../../lib/unknown-text.js";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { streamText, type LanguageModelUsage, type ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import type {
    LanguageModelV4CallOptions,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
    LanguageModelV4Usage,
    SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { ResultAsync, errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../__fixtures__/session.js";
import {
    computeRetryDelayMs,
    createAiSdkProvider,
    createConfiguredAiSdkProvider,
    DEFAULT_MAX_OUTPUT_TOKENS,
    fallbackModelOf,
    RETRY_BACKOFF_FACTOR,
    RETRY_INITIAL_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRY_MAX_RETRIES,
    sessionKeyDigestOf,
    sessionKeyOf,
    toChatUsage,
} from "../ai-sdk.js";
import { forSubAgent, type AgentSession, type RunFrame, type Scope } from "../../auth/types.js";
import type { LlmUsageRecord, UsageRecorder } from "../../billing/usage-recorder.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { LogFields, Logger } from "../../lib/logger.js";
import type { GateFailure } from "../../lib/hooks.js";
import { runLoop, type LoopOptions } from "../../loop/run-loop.js";
import type { AgentDefinition, LoopMessage } from "../../loop/types.js";
import { reasoning, scriptedModel, text, type ScriptedReply } from "../../testing.js";
import { defineTool } from "../../tools/define-tool.js";
import { findProviderError, type ProviderError } from "../errors.js";
import type { ChatProvider, ReasoningPolicy } from "../types.js";
import { presentAt } from "../../lib/present.js";

const USAGE: LanguageModelV4Usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
};

type StreamDouble = (options: LanguageModelV4CallOptions) => Promise<LanguageModelV4StreamResult>;

/** A model double that records each attempt in `doStreamCalls`. */
function fakeModel(doStream: StreamDouble): MockLanguageModelV4 {
    return new MockLanguageModelV4({ provider: "fake-provider", modelId: "fake-model", doStream });
}

function finishPart(options: { readonly usage?: LanguageModelV4Usage; readonly providerMetadata?: SharedV4ProviderMetadata } = {}): LanguageModelV4StreamPart {
    return { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: options.usage ?? USAGE, providerMetadata: options.providerMetadata };
}

/** A clean reply that streams `deltas` as one text part. A reply with no delta has no text part. */
function replyOf(deltas: readonly string[], finish: LanguageModelV4StreamPart = finishPart()): LanguageModelV4StreamResult {
    const textParts: LanguageModelV4StreamPart[] =
        deltas.length === 0
            ? []
            : [
                  { type: "text-start", id: "txt-1" },
                  ...deltas.map((delta): LanguageModelV4StreamPart => ({ type: "text-delta", id: "txt-1", delta })),
                  { type: "text-end", id: "txt-1" },
              ];
    return { stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([{ type: "stream-start", warnings: [] }, ...textParts, finish]) };
}

/** A model that gives the same clean reply to each call. */
function replyingModel(deltas: readonly string[] = ["ok"], finish?: LanguageModelV4StreamPart): MockLanguageModelV4 {
    return fakeModel(() => Promise.resolve(replyOf(deltas, finish)));
}

/**
 * A real 503 `APICallError` naming a zero-millisecond `retry-after-ms` by
 * default. Retry backoff is a genuine wall-clock sleep here — the provider
 * injects no timer — so a server-named 0ms delay is what lets a full
 * exhaustion run (1 + RETRY_MAX_RETRIES attempts) finish inside bun's 5s
 * per-test budget while still exercising the real header-honoring path. Pass
 * other headers to drive the delay/classification a specific test needs.
 */
function apiError503(responseHeaders: Record<string, string> = { "retry-after-ms": "0" }): APICallError {
    return new APICallError({
        message: "upstream unavailable",
        url: "https://model.test/v1/messages",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders,
        isRetryable: true,
    });
}

/** A stream that fails before its first output part: the stream itself errors, with no `error` part. */
function streamErrorsBeforeDelta(error: unknown): LanguageModelV4StreamResult {
    return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.error(error);
            },
        }),
    };
}

/**
 * A stream that delivers exactly one text delta and then errors. The error is
 * raised on a later pull rather than in the same tick as the delta so the
 * consumer observes the delta before the failure — a same-tick `controller.error`
 * races ahead of the buffered delta and the consumer never sees it.
 */
function streamDeltaThenError(delta: string, error: unknown): LanguageModelV4StreamResult {
    let step = 0;
    return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
            pull(controller) {
                step += 1;
                if (step === 1) controller.enqueue({ type: "stream-start", warnings: [] });
                else if (step === 2) controller.enqueue({ type: "text-start", id: "txt-1" });
                else if (step === 3) controller.enqueue({ type: "text-delta", id: "txt-1", delta });
                else controller.error(error);
            },
        }),
    };
}

type DriveCall = {
    readonly session?: AgentSession;
    readonly reasoning?: ReasoningPolicy;
    readonly live?: boolean;
    readonly signal?: AbortSignal;
    readonly messages?: ModelMessage[];
    /** Sees the type of each part of the full stream, in order. */
    readonly onPart?: (type: string) => void;
};

/** What a reader of one model call saw. */
type Outcome = {
    readonly deltas: readonly string[];
    readonly text: string;
    /** The first failure that the call reported, as the AI SDK gave it. */
    readonly failure: unknown;
    readonly aborted: boolean;
    readonly finishReason?: string;
    readonly usage?: LanguageModelUsage;
};

/** Run one model call over the bound model of `provider`, the same way the loop runs each request. */
async function drive(provider: ChatProvider, call: DriveCall = {}): Promise<Outcome> {
    const bound = provider.bind({ session: call.session ?? makeSession(), reasoning: call.reasoning, live: call.live ?? false });
    let failure: unknown;
    const result = streamText({
        model: bound.model,
        ...bound.settings,
        maxRetries: 0,
        messages: call.messages ?? [{ role: "user", content: "hello" }],
        abortSignal: call.signal,
        onError: ({ error }) => {
            failure ??= error;
        },
    });
    const deltas: string[] = [];
    let aborted = false;
    let finishReason: string | undefined;
    let usage: LanguageModelUsage | undefined;
    for await (const part of result.stream) {
        call.onPart?.(part.type);
        if (part.type === "text-delta") deltas.push(part.text);
        else if (part.type === "abort") aborted = true;
        else if (part.type === "finish-step") {
            finishReason = part.finishReason;
            usage = part.usage;
        }
    }
    return { deltas, text: deltas.join(""), failure, aborted, finishReason, usage };
}

/** The classified failure of a call that the retry envelope gave up on. */
function providerErrorOf(outcome: Outcome): ProviderError {
    const error = findProviderError(outcome.failure);
    if (error === undefined) throw new Error(`expected a provider error, got ${textOf(outcome.failure)}`, { cause: outcome.failure });
    return error;
}

/** The headers of one call, with each name folded to lowercase: a header name is case-insensitive on the wire. */
function headersOf(call: LanguageModelV4CallOptions): Record<string, string | undefined> {
    return Object.fromEntries(Object.entries(call.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
}

type LogRecord = { readonly level: "warn" | "error"; readonly msg: string; readonly fields?: LogFields };

/** A logger that keeps each record at `warn` and at `error`. */
function recordingLogger(): { logger: Logger; records: LogRecord[] } {
    const records: LogRecord[] = [];
    const base = createNoopLogger();
    const keep =
        (level: LogRecord["level"]) =>
        (msg: string, fields?: LogFields): void => {
            records.push(fields === undefined ? { level, msg } : { level, msg, fields });
        };
    const logger: Logger = {
        ...base,
        warn: keep("warn"),
        error: keep("error"),
        with: () => logger,
        named: () => logger,
        errorFields: (err) => ({ error: errorMessageOf(err) ?? textOf(err) }),
    };
    return { logger, records };
}

function recordingUsage(): { usageRecorder: UsageRecorder; records: LlmUsageRecord[] } {
    const records: LlmUsageRecord[] = [];
    return {
        records,
        usageRecorder: {
            record: (record) => {
                records.push(record);
                return okAsync(undefined);
            },
        },
    };
}

function agentWith(tools: AgentDefinition["tools"] = []): AgentDefinition {
    return { id: "test-agent", systemPrompt: "You are a test agent.", model: "fake-model", tools, maxIterations: 1 };
}

function loopOptions(provider: ChatProvider, extra: Partial<LoopOptions> = {}): LoopOptions {
    return { provider, emit: () => undefined, signal: new AbortController().signal, ...extra };
}

describe("createAiSdkProvider", () => {
    it("runs an embedder-supplied AI SDK language model and adds the headers of the hook as the hook gives them", async () => {
        const model = replyingModel(["done"]);
        const provider = createAiSdkProvider({
            model,
            resolveRequestHeaders: () => okAsync({ "x-attribution": "a1", "x-no-harness-name": "v2" }),
        });

        const outcome = await drive(provider);

        expect(outcome.failure).toBeUndefined();
        expect(outcome.text).toBe("done");
        expect(headersOf(presentAt(model.doStreamCalls, 0))).toMatchObject({
            "x-attribution": "a1",
            "x-no-harness-name": "v2",
        });
    });

    it("adds no header from a hook when the provider has no hook", async () => {
        const model = replyingModel(["done"]);
        const provider = createAiSdkProvider({ model });

        expect((await drive(provider)).failure).toBeUndefined();
        expect(Object.keys(headersOf(presentAt(model.doStreamCalls, 0))).filter((name) => name.startsWith("x-attribution"))).toEqual([]);
    });

    it("gives a 402 as a suspend error with the default reason, and no budget word", async () => {
        const provider = createAiSdkProvider({
            model: fakeModel(() => Promise.reject(Object.assign(new Error("payment required"), { status: 402 }))),
        });

        const failure = providerErrorOf(await drive(provider));

        expect(failure).toMatchObject({ type: "suspend", status: 402, reason: "payment_required", retryable: false });
        expect(failure.message).toContain("HTTP 402");
        const lowerMessage = failure.message.toLowerCase();
        expect(["budget", "tenant", "billing"].some((word) => lowerMessage.includes(word))).toBe(false);
    });

    it("gives an unmapped 403 as a non-retryable provider error", async () => {
        const provider = createAiSdkProvider({
            model: fakeModel(() => Promise.reject(Object.assign(new Error("forbidden"), { status: 403 }))),
        });

        expect(providerErrorOf(await drive(provider))).toMatchObject({ type: "provider", retryable: false });
    });

    it("uses a map from the host in place of the default map", async () => {
        const failing = (status: number) =>
            createAiSdkProvider({
                model: fakeModel(() => Promise.reject(Object.assign(new Error("refused"), { status }))),
                suspendOn: { 429: "quota" },
            });

        expect(providerErrorOf(await drive(failing(429)))).toMatchObject({ type: "suspend", status: 429, reason: "quota" });
        expect(providerErrorOf(await drive(failing(402)))).toMatchObject({ type: "provider", retryable: false });
    });

    it("ends an aborted call as an abort, and classifies nothing", async () => {
        const controller = new AbortController();
        const model = fakeModel(() => {
            controller.abort();
            return Promise.reject(new DOMException("aborted", "AbortError"));
        });
        const provider = createAiSdkProvider({ model });

        const outcome = await drive(provider, { signal: controller.signal });

        expect(outcome.aborted).toBe(true);
        expect(outcome.failure).toBeUndefined();
        expect(model.doStreamCalls).toHaveLength(1);
    });

    it("streams the deltas of a live call as the model sends them", async () => {
        const model = replyingModel(["he", "llo"]);
        const provider = createAiSdkProvider({ model, resolveRequestHeaders: () => okAsync({ "x-attribution": "a1" }) });

        const outcome = await drive(provider, { live: true });

        expect(outcome.deltas).toEqual(["he", "llo"]);
        expect(outcome.finishReason).toBe("stop");
        expect(model.doStreamCalls).toHaveLength(1);
        expect(headersOf(presentAt(model.doStreamCalls, 0))).toMatchObject({ "x-attribution": "a1" });
    });

    it("rejects a tool-required agent before the first model call when tool calling is off", async () => {
        const model = replyingModel();
        const provider = createAiSdkProvider({ model, capabilities: { toolCalling: false } });
        const tool = defineTool({
            id: "echo",
            description: "Echo the text.",
            inputSchema: z.object({ text: z.string() }),
            describeCall: "none",
            execute: (input) => Promise.resolve(ok({ echoed: input.text })),
        });

        expect(provider.capabilities.toolCalling).toBe(false);
        await expect(runLoop(agentWith([tool]), [{ role: "user", content: "go" }], makeSession(), loopOptions(provider))).rejects.toThrow(
            'Provider/model cannot run tool-required agent "test-agent"',
        );
        expect(model.doStreamCalls).toHaveLength(0);
    });

    it("turns tool calling on when the caller states nothing", () => {
        expect(createAiSdkProvider({ model: replyingModel() }).capabilities.toolCalling).toBe(true);
    });

    // An absent picture flag means "cannot carry", never "unknown". Thus the
    // factory copies a stated flag, and it invents no value for an absent one.
    it("copies a stated picture flag and context window, and leaves absent ones absent", () => {
        const declared = createAiSdkProvider({ model: replyingModel(), capabilities: { imageToolResults: true, contextWindow: 200_000 } });
        const silent = createAiSdkProvider({ model: replyingModel(), capabilities: { toolCalling: true } });

        expect(declared.capabilities.imageToolResults).toBe(true);
        expect(declared.capabilities.contextWindow).toBe(200_000);
        expect(silent.capabilities.imageToolResults).toBeUndefined();
        expect(silent.capabilities.contextWindow).toBeUndefined();
    });

    it("advertises the request timeout of the deps, and none when the deps name none", () => {
        expect(createAiSdkProvider({ model: replyingModel(), requestTimeoutMs: 1_234 }).requestTimeoutMs).toBe(1_234);
        expect(createAiSdkProvider({ model: replyingModel() }).requestTimeoutMs).toBeUndefined();
    });
});

describe("output ceiling", () => {
    it("sends the default ceiling when the deps name none", async () => {
        const model = replyingModel();

        await drive(createAiSdkProvider({ model }));

        expect(presentAt(model.doStreamCalls, 0).maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });

    it("sends the ceiling that the deps name", async () => {
        const model = replyingModel();

        await drive(createAiSdkProvider({ model, maxOutputTokens: 8_192 }));

        expect(presentAt(model.doStreamCalls, 0).maxOutputTokens).toBe(8_192);
    });

    it("sends no ceiling for the provider-maximum sentinel, thus the server holds the cap of the model", async () => {
        const model = replyingModel();
        const provider = createAiSdkProvider({ model, maxOutputTokens: "provider-maximum" });

        await drive(provider);

        expect(provider.bind({ session: makeSession(), live: false }).settings).not.toHaveProperty("maxOutputTokens");
        expect(presentAt(model.doStreamCalls, 0).maxOutputTokens).toBeUndefined();
    });
});

describe("empty text block sanitization", () => {
    // The Anthropic API 400s on any request containing an empty text block, and
    // a stored thread can hold one: the response of a turn that goes straight to
    // tool calls has one, and the loop sends that history back.
    it("strips empty text parts from echoed history before the wire call", async () => {
        const { provider, calls } = scriptedModel([{ content: [text("done")], finishReason: "stop" }]);
        const history: LoopMessage[] = [
            { role: "user", content: "profile the files" },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "" },
                    { type: "tool-call", toolCallId: "tc-1", toolName: "execute_command", input: { command: "ls" } },
                ],
            },
            {
                role: "tool",
                content: [{ type: "tool-result", toolCallId: "tc-1", toolName: "execute_command", output: { type: "text", value: "ok" } }],
            },
            { role: "assistant", content: "" },
        ];

        await runLoop(agentWith(), history, makeSession(), loopOptions(provider));

        const prompt = presentAt(calls, 0).prompt;
        const textParts = prompt.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "text") : []));
        for (const part of textParts) {
            expect(part.text).not.toBe("");
        }
        // The tool call survives the strip; the all-empty assistant message is dropped whole.
        const json = JSON.stringify(prompt);
        expect(json).toContain("tc-1");
        expect(json).not.toContain('"text":""');
    });
});

describe("usage reporting", () => {
    // The cache breakdown rides on the SDK's vendor-neutral `inputTokenDetails`
    // (`@ai-sdk/anthropic` normalizes `cache_read_input_tokens` /
    // `cache_creation_input_tokens` into it) — not on `providerMetadata`, which
    // carries only the raw snake_case vendor payload.
    const usageOf = async (usage: LanguageModelV4Usage) =>
        toChatUsage((await drive(createAiSdkProvider({ model: replyingModel(["done"], finishPart({ usage })) }))).usage);

    it("maps the input, output, and cache tokens of a reply onto the neutral fields", async () => {
        const usage = await usageOf({
            inputTokens: { total: 2000, noCache: 100, cacheRead: 1700, cacheWrite: 200 },
            outputTokens: { total: 42, text: 42, reasoning: 0 },
        });

        expect(usage).toEqual({
            inputTokens: 2000,
            outputTokens: 42,
            cacheCreationInputTokens: 200,
            cacheReadInputTokens: 1700,
            reasoningTokens: 0,
        });
    });

    it("leaves cache fields undefined when a provider reports no cache breakdown", async () => {
        const usage = await usageOf({
            inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
        });

        expect(usage?.inputTokens).toBe(50);
        expect(usage?.cacheReadInputTokens).toBeUndefined();
        expect(usage?.cacheCreationInputTokens).toBeUndefined();
    });

    it("carries a reported reasoning count verbatim, without reconciling it against the output total", async () => {
        const usage = await usageOf({
            inputTokens: { total: 120, noCache: 120, cacheRead: undefined, cacheWrite: undefined },
            // A provider counting reasoning OUTSIDE its output total: 90 + 40
            // does not equal `total`. Neither figure may be adjusted to fit the
            // other — whether reasoning is a subset of output is the provider's
            // convention, not the harness's arithmetic.
            outputTokens: { total: 90, text: 90, reasoning: 40 },
        });

        expect(usage?.reasoningTokens).toBe(40);
        expect(usage?.outputTokens).toBe(90);
    });

    it("leaves reasoningTokens undefined — never zero — when a provider reports no reasoning count", async () => {
        const usage = await usageOf({
            inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
        });

        expect(usage?.reasoningTokens).toBeUndefined();
        expect(usage?.outputTokens).toBe(5);
    });

    it("gives no usage for a call that reported none", () => {
        expect(toChatUsage(undefined)).toBeUndefined();
    });
});

describe("the order of the reasoning effort", () => {
    async function sentReasoning(configured: ReasoningPolicy | undefined, bound: ReasoningPolicy | undefined): Promise<(ReasoningPolicy | undefined)[]> {
        const model = replyingModel();
        const provider = createAiSdkProvider({ model, reasoning: configured });
        await drive(provider, { reasoning: bound });
        await drive(provider, { reasoning: bound, live: true });
        return model.doStreamCalls.map((call) => call.reasoning);
    }

    it("sends the value of the run over the configured value", async () => {
        expect(await sentReasoning("high", "low")).toEqual(["low", "low"]);
    });

    it("applies the configured value to a run that sets none", async () => {
        expect(await sentReasoning("high", undefined)).toEqual(["high", "high"]);
    });

    it("applies xhigh when neither the run nor the configuration sets a value", async () => {
        expect(await sentReasoning(undefined, undefined)).toEqual(["xhigh", "xhigh"]);
    });
});

describe("sessionKeyOf", () => {
    function sessionWith(threadId?: string, runFrame?: RunFrame): AgentSession {
        const scope: Scope = { kind: "analysis", analysisId: "a1", threadId };
        return { ...makeSession({ scope }), runFrame };
    }

    it.each<[string, AgentSession, string]>([
        ["a run frame with a step gives the step key", sessionWith(undefined, { runId: "r1", stepId: "s1" }), "a1:r1:s1"],
        ["a run frame without a step gives the run key", sessionWith(undefined, { runId: "r1" }), "a1:r1"],
        ["a scope with a thread gives the thread key", sessionWith("t1"), "a1:t1"],
        ["a scope with no thread and no run frame gives the analysis id", sessionWith(), "a1"],
    ])("%s", (_label, session, key) => {
        expect(sessionKeyOf(session)).toBe(key);
    });

    it("gives a run that a chat started the run key, not the key of the chat", () => {
        // The scope of the run carries the thread of the chat that started it.
        expect(sessionKeyOf(sessionWith("t1", { runId: "r1" }))).toBe("a1:r1");
    });

    it("gives a sub-agent the key of its parent", () => {
        const parent = sessionWith("t1", { runId: "r1", stepId: "s1" });

        const child = forSubAgent(parent, "literature-reviewer");

        expect(child.provenance).not.toEqual(parent.provenance);
        expect(sessionKeyOf(child)).toBe(sessionKeyOf(parent));
    });
});

describe("sessionKeyDigestOf", () => {
    /** A step session with identifiers of production length: two UUIDs and a plan step id. */
    function stepSession(stepId: string): AgentSession {
        return {
            ...makeSession({ scope: { kind: "analysis", analysisId: "0b7f3c52-6f0e-4d8a-9a51-2f6c1e9d4b3a", threadId: "t1" } }),
            runFrame: { runId: "5c2e9a10-8d4b-4f7e-b1a3-6e0d2c9f7a84", stepId },
        };
    }

    it("gives a key within the limit of 64 characters of the vendor", () => {
        const session = stepSession("T1S1");

        // The identifier string alone passes the limit.
        expect(sessionKeyOf(session).length).toBeGreaterThan(64);
        expect(BASE64URL_DIGEST_43.test(sessionKeyDigestOf(session))).toBe(true);
    });

    it("gives the base64url SHA-256 digest of the identifier string, the same each time", () => {
        const session = stepSession("T1S1");

        expect(sessionKeyDigestOf(session)).toBe(createHash("sha256").update(sessionKeyOf(session)).digest("base64url"));
        expect(sessionKeyDigestOf(session)).toBe(sessionKeyDigestOf(stepSession("T1S1")));
    });

    it("gives a sub-agent the key of its parent", () => {
        const parent = stepSession("T1S1");

        expect(sessionKeyDigestOf(forSubAgent(parent, "literature-reviewer"))).toBe(sessionKeyDigestOf(parent));
    });

    it("gives two steps of one run different keys", () => {
        expect(sessionKeyDigestOf(stepSession("T1S1"))).not.toBe(sessionKeyDigestOf(stepSession("T1S2")));
    });
});

describe("createConfiguredAiSdkProvider", () => {
    it("constructs an OpenAI-compatible provider from endpoint/key/model configuration", () => {
        const provider = createConfiguredAiSdkProvider({
            config: {
                kind: "openai-compatible",
                name: "self-hosted",
                baseURL: "http://models.local/v1",
                apiKey: "test-key",
                model: "local-tool-model",
                capabilities: { toolCalling: true },
            },
        });

        expect(provider.capabilities.toolCalling).toBe(true);
    });

    // The picture flag is a fact about the endpoint, not about the dialect. An
    // absent flag means "cannot carry", thus the loop degrades to text.
    it("asserts the picture capability for the default anthropic endpoint", () => {
        const provider = createConfiguredAiSdkProvider({
            config: { kind: "anthropic", apiKey: "test-key", model: "claude-opus-5" },
        });

        expect(provider.capabilities.imageToolResults).toBe(true);
    });

    it("leaves the picture capability absent for an anthropic config with a custom endpoint", () => {
        const provider = createConfiguredAiSdkProvider({
            config: { kind: "anthropic", baseURL: "http://models.local/anthropic", apiKey: "test-key", model: "claude-opus-5" },
        });

        expect(provider.capabilities.imageToolResults).toBeUndefined();
    });

    it("honors the config over the endpoint default in both directions", () => {
        const declared = createConfiguredAiSdkProvider({
            config: {
                kind: "anthropic",
                baseURL: "http://models.local/anthropic",
                apiKey: "test-key",
                model: "claude-opus-5",
                capabilities: { imageToolResults: true },
            },
        });
        const refused = createConfiguredAiSdkProvider({
            config: { kind: "anthropic", apiKey: "test-key", model: "claude-opus-5", capabilities: { imageToolResults: false } },
        });

        expect(declared.capabilities.imageToolResults).toBe(true);
        expect(refused.capabilities.imageToolResults).toBe(false);
    });
});

describe("computeRetryDelayMs", () => {
    it("scales the exponential input with full jitter and caps it at the ceiling", () => {
        // random = () => 1 removes jitter, so the result is the capped input itself.
        const noJitter = () => 1;
        expect(computeRetryDelayMs(new Error("transient"), 2_000, noJitter)).toBe(2_000);
        expect(computeRetryDelayMs(new Error("transient"), 4_000, noJitter)).toBe(4_000);
        expect(computeRetryDelayMs(new Error("transient"), 8_000, noJitter)).toBe(8_000);
        expect(computeRetryDelayMs(new Error("transient"), 16_000, noJitter)).toBe(16_000);
        expect(computeRetryDelayMs(new Error("transient"), 32_000, noJitter)).toBe(RETRY_MAX_DELAY_MS);
    });

    it("spreads the delay across the full jitter window for a fixed input", () => {
        expect(computeRetryDelayMs(new Error("transient"), 10_000, () => 0)).toBe(0);
        expect(computeRetryDelayMs(new Error("transient"), 10_000, () => 0.5)).toBe(5_000);
    });

    it("honors a server-named retry-after-ms exactly, ignoring jitter", () => {
        expect(computeRetryDelayMs(apiError503({ "retry-after-ms": "1500" }), 8_000, () => 0.9)).toBe(1_500);
    });

    it("reads retry-after seconds and an HTTP-date retry-after", () => {
        expect(computeRetryDelayMs(apiError503({ "retry-after": "2" }), 8_000, () => 1)).toBe(2_000);

        const tenSecondsOut = new Date(Date.now() + 10_000).toUTCString();
        const ms = computeRetryDelayMs(apiError503({ "retry-after": tenSecondsOut }), 8_000, () => 1);
        // HTTP dates carry no sub-second precision, so the parsed offset lands a
        // little under the full 10s window it names.
        expect(ms).toBeGreaterThan(8_000);
        expect(ms).toBeLessThanOrEqual(10_000);
    });

    it("falls back to jitter when the server-named delay is outside the envelope", () => {
        // Above the ceiling and negative are both treated as absent, so the
        // jittered exponential governs instead of the verbatim header value.
        expect(computeRetryDelayMs(apiError503({ "retry-after-ms": "30001" }), 2_000, () => 1)).toBe(2_000);
        expect(computeRetryDelayMs(apiError503({ "retry-after-ms": "-5" }), 2_000, () => 1)).toBe(2_000);
    });

    it("reads the retry-after header from an APICallError one cause hop down", () => {
        const wrapped = new Error("rewrapped by the SDK", { cause: apiError503({ "retry-after-ms": "1200" }) });
        expect(computeRetryDelayMs(wrapped, 8_000, () => 0.1)).toBe(1_200);
    });

    it("reads the retry-after header through a null-prototype wrapper", () => {
        // A proxy can rethrow the SDK error inside a bare object with no prototype; the
        // one-hop walk must still reach the APICallError on its cause.
        const wrapper: Record<string, unknown> = { cause: apiError503({ "retry-after-ms": "1200" }) };
        Object.setPrototypeOf(wrapper, null);
        expect(computeRetryDelayMs(wrapper, 8_000, () => 0.1)).toBe(1_200);
    });
});

describe("the retry envelope", () => {
    it("retries a connection failure and succeeds on the next attempt", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(() => {
                attempts += 1;
                if (attempts === 1) {
                    return Promise.reject(
                        Object.assign(new TypeError("fetch failed"), {
                            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
                        }),
                    );
                }
                return Promise.resolve(replyOf(["recovered"]));
            }),
        });

        const outcome = await drive(provider);

        expect(outcome.failure).toBeUndefined();
        expect(outcome.text).toBe("recovered");
        expect(attempts).toBe(2);
        // A single connection retry has no server-named delay, so it sleeps a
        // real jittered backoff of up to the 2s initial window.
    }, 10_000);

    it("returns the classified error after exactly one attempt for a non-retryable status", async () => {
        const cases = [
            { status: 401, type: "auth" },
            { status: 402, type: "suspend" },
            { status: 403, type: "provider" },
            { status: 400, type: "provider" },
        ] as const;

        for (const { status, type } of cases) {
            const model = fakeModel(() => Promise.reject(Object.assign(new Error(`HTTP ${status}`), { status })));

            const failure = providerErrorOf(await drive(createAiSdkProvider({ model })));

            expect(failure.type).toBe(type);
            expect(failure.retryable).toBe(false);
            expect(model.doStreamCalls).toHaveLength(1);
        }
    });

    it("exhausts retries on a persistent retryable failure and preserves the transient classification", async () => {
        // The 503 reaches classification down the retry wrapper's cause chain;
        // asserting type/retryable proves it stayed reachable.
        const model = fakeModel(() => Promise.reject(apiError503()));

        const failure = providerErrorOf(await drive(createAiSdkProvider({ model })));

        expect(model.doStreamCalls).toHaveLength(1 + RETRY_MAX_RETRIES);
        expect(failure.type).toBe("provider");
        expect(failure.retryable).toBe(true);
    });

    it("bounds the envelope by a configured maxRetries in place of the default", async () => {
        const model = fakeModel(() => Promise.reject(apiError503()));

        const failure = providerErrorOf(await drive(createAiSdkProvider({ model, maxRetries: 2 })));

        expect(model.doStreamCalls).toHaveLength(3);
        expect(failure.type).toBe("provider");
        expect(failure.retryable).toBe(true);
    });

    it("calls the request headers hook before each attempt", async () => {
        let hookCalls = 0;
        const model = fakeModel(() => (hookCalls === 1 ? Promise.reject(apiError503()) : Promise.resolve(replyOf(["ok"]))));
        const provider = createAiSdkProvider({
            model,
            resolveRequestHeaders: () => {
                hookCalls += 1;
                return okAsync({ "x-attempt": `attempt-${hookCalls}` });
            },
        });

        const outcome = await drive(provider);

        expect(outcome.failure).toBeUndefined();
        expect(hookCalls).toBe(2);
        expect(model.doStreamCalls).toHaveLength(2);
        expect(headersOf(presentAt(model.doStreamCalls, 1))).toMatchObject({ "x-attempt": "attempt-2" });
    });

    it("never retries a status that the map of the host holds", async () => {
        const model = fakeModel(() => Promise.reject(Object.assign(new Error("HTTP 429"), { status: 429 })));

        const failure = providerErrorOf(await drive(createAiSdkProvider({ model, suspendOn: { 429: "quota_exhausted" } })));

        expect(failure).toMatchObject({ type: "suspend", status: 429, reason: "quota_exhausted", retryable: false });
        expect(model.doStreamCalls).toHaveLength(1);
    });
});

describe("an abort during the backoff", () => {
    it("abandons a pending retry backoff when the signal fires", async () => {
        // A 4s server-named delay makes the backoff long enough that only
        // the abort — not the delay elapsing — can end the call quickly.
        const model = fakeModel(() => Promise.reject(apiError503({ "retry-after-ms": "4000" })));
        const controller = new AbortController();
        const startedAt = Date.now();

        // The abort lands while the call waits out the server-named backoff, so only the abort can end it quickly.
        const pending = drive(createAiSdkProvider({ model }), { signal: controller.signal });
        await sleep(50);
        controller.abort();
        const outcome = await pending;

        expect(outcome.aborted).toBe(true);
        expect(outcome.failure).toBeUndefined();
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(model.doStreamCalls).toHaveLength(1);
    }, 10_000);

    it("does not loop when a wall-clock guard of the caller expires", async () => {
        // A wall-clock guard of a caller aborts with a `TimeoutError` reason, which
        // the taxonomy marks as a retryable timeout. The aborted caller signal
        // stops the envelope, thus one attempt runs and the call ends as an abort.
        const controller = new AbortController();
        const model = fakeModel(() => {
            const expiry = new DOMException("The operation timed out.", "TimeoutError");
            controller.abort(expiry);
            return Promise.reject(expiry);
        });

        const outcome = await drive(createAiSdkProvider({ model }), { signal: controller.signal });

        expect(outcome.aborted).toBe(true);
        expect(outcome.failure).toBeUndefined();
        expect(model.doStreamCalls).toHaveLength(1);
    });
});

describe("a live call and a buffered call", () => {
    it("retries a live call whose stream fails before the first output part, and then streams the recovered deltas", async () => {
        let attempts = 0;
        const model = fakeModel(() => {
            attempts += 1;
            return Promise.resolve(attempts === 1 ? streamErrorsBeforeDelta(apiError503()) : replyOf(["a", "b"]));
        });

        const outcome = await drive(createAiSdkProvider({ model }), { live: true });

        expect(model.doStreamCalls).toHaveLength(2);
        expect(outcome.failure).toBeUndefined();
        expect(outcome.deltas).toEqual(["a", "b"]);
        expect(outcome.finishReason).toBe("stop");
    });

    it("retries a live call whose doStream rejects, and then streams the recovered deltas", async () => {
        let attempts = 0;
        const model = fakeModel(() => {
            attempts += 1;
            return attempts === 1 ? Promise.reject(apiError503()) : Promise.resolve(replyOf(["a", "b"]));
        });

        const outcome = await drive(createAiSdkProvider({ model }), { live: true });

        expect(model.doStreamCalls).toHaveLength(2);
        expect(outcome.failure).toBeUndefined();
        expect(outcome.deltas).toEqual(["a", "b"]);
    });

    it("does not retry a live call or show its start again once the first output part reached the reader", async () => {
        const model = fakeModel(() => Promise.resolve(streamDeltaThenError("a", apiError503())));

        const outcome = await drive(createAiSdkProvider({ model }), { live: true });

        expect(outcome.deltas).toEqual(["a"]);
        expect(providerErrorOf(outcome)).toMatchObject({ type: "provider", retryable: true });
        expect(model.doStreamCalls).toHaveLength(1);
    });

    it("retries a buffered call that fails mid-stream, and shows the reader only the reply of the attempt that completed", async () => {
        let attempts = 0;
        const model = fakeModel(() => {
            attempts += 1;
            return Promise.resolve(attempts === 1 ? streamDeltaThenError("a", apiError503()) : replyOf(["a", "b"]));
        });

        const outcome = await drive(createAiSdkProvider({ model }), { live: false });

        expect(model.doStreamCalls).toHaveLength(2);
        expect(outcome.failure).toBeUndefined();
        expect(outcome.deltas).toEqual(["a", "b"]);
    });

    it("exhausts the retries of a stream that fails before any output, and fails with the classified provider error", async () => {
        const model = fakeModel(() => Promise.resolve(streamErrorsBeforeDelta(apiError503())));

        const outcome = await drive(createAiSdkProvider({ model }), { live: true });

        expect(model.doStreamCalls).toHaveLength(1 + RETRY_MAX_RETRIES);
        expect(outcome.deltas).toEqual([]);
        expect(providerErrorOf(outcome)).toMatchObject({ type: "provider", retryable: true });
    });

    it("exhausts retries on a persistently rejecting doStream and fails with the classified provider error", async () => {
        const model = fakeModel(() => Promise.reject(apiError503()));

        const outcome = await drive(createAiSdkProvider({ model }), { live: true });

        expect(model.doStreamCalls).toHaveLength(1 + RETRY_MAX_RETRIES);
        expect(providerErrorOf(outcome)).toMatchObject({ type: "provider", retryable: true });
    });

    it("does not retry a clean text-less turn", async () => {
        for (const live of [true, false]) {
            const model = replyingModel([]);

            const outcome = await drive(createAiSdkProvider({ model }), { live });

            expect(model.doStreamCalls).toHaveLength(1);
            expect(outcome.failure).toBeUndefined();
            expect(outcome.deltas).toEqual([]);
            expect(outcome.finishReason).toBe("stop");
        }
    });
});

describe("retry policy constants", () => {
    // The behavioral tests above assert attempt counts self-referentially (e.g.
    // `1 + RETRY_MAX_RETRIES`), so a drifted constant would keep the whole suite
    // green while silently changing the spec'd envelope. Pin the values directly.
    it("match the specified envelope", () => {
        expect(RETRY_MAX_RETRIES).toBe(10);
        expect(RETRY_INITIAL_DELAY_MS).toBe(2_000);
        expect(RETRY_BACKOFF_FACTOR).toBe(2);
        expect(RETRY_MAX_DELAY_MS).toBe(30_000);
    });
});

describe("the request headers hook", () => {
    it("stops the call at once on a hook err, sends no request, and never retries", async () => {
        let hookCalls = 0;
        const model = replyingModel();
        const provider = createAiSdkProvider({
            model,
            resolveRequestHeaders: () => {
                hookCalls += 1;
                return errAsync({ reason: "attribution refused", suspend: false });
            },
        });

        const failure = providerErrorOf(await drive(provider));

        expect(failure).toMatchObject({ type: "provider", retryable: false });
        expect(failure.message).toContain("attribution refused");
        expect(failure.message).toContain("analysis:");
        expect(model.doStreamCalls).toHaveLength(0);
        expect(hookCalls).toBe(1);
    });

    it("gives a suspend error with the reason and no status on a hook err with the suspend flag", async () => {
        const provider = createAiSdkProvider({
            model: replyingModel(),
            resolveRequestHeaders: () => errAsync({ reason: "account_frozen", suspend: true }),
        });

        const failure = providerErrorOf(await drive(provider));

        expect(failure).toMatchObject({ type: "suspend", reason: "account_frozen", retryable: false });
        expect(failure.type === "suspend" ? failure.status : "not a suspend error").toBeUndefined();
    });

    it("stops the retries when the hook refuses a later attempt", async () => {
        let hookCalls = 0;
        const model = fakeModel(() => Promise.reject(apiError503()));
        const provider = createAiSdkProvider({
            model,
            resolveRequestHeaders: () => {
                hookCalls += 1;
                return hookCalls === 1 ? okAsync({}) : errAsync({ reason: "second refused", suspend: false });
            },
        });

        const failure = providerErrorOf(await drive(provider));

        expect(model.doStreamCalls).toHaveLength(1);
        expect(hookCalls).toBe(2);
        expect(failure).toMatchObject({ type: "provider", retryable: false });
        expect(failure.message).toContain("second refused");
    }, 10_000);

    it("keeps the suspend flag and the reason when the hook refuses a later attempt", async () => {
        let hookCalls = 0;
        const model = fakeModel(() => Promise.reject(apiError503()));
        const provider = createAiSdkProvider({
            model,
            resolveRequestHeaders: () => {
                hookCalls += 1;
                // The reason holds a word that the wire taxonomy matches in a message. The
                // harness must not read it: the refusal keeps its own kind.
                return hookCalls === 1 ? okAsync({}) : errAsync({ reason: "terminated_by_host", suspend: true });
            },
        });

        const failure = providerErrorOf(await drive(provider));

        expect(model.doStreamCalls).toHaveLength(1);
        expect(hookCalls).toBe(2);
        expect(failure).toMatchObject({ type: "suspend", reason: "terminated_by_host", retryable: false });
    }, 10_000);

    it("passes a rejected hook promise through with no change, and never retries it", async () => {
        let hookCalls = 0;
        // The text of a connection failure, which the wire taxonomy would retry.
        const rejection = new TypeError("fetch failed");
        const model = replyingModel();
        const provider = createAiSdkProvider({
            model,
            resolveRequestHeaders: () => {
                hookCalls += 1;
                return new ResultAsync<Record<string, string>, GateFailure>(Promise.reject(rejection));
            },
        });

        const outcome = await drive(provider);

        expect(outcome.failure).toBe(rejection);
        expect(hookCalls).toBe(1);
        expect(model.doStreamCalls).toHaveLength(0);
    });

    it("fails a live call at once on a hook err without opening the stream", async () => {
        const model = replyingModel(["a"]);
        const provider = createAiSdkProvider({
            model,
            resolveRequestHeaders: () => errAsync({ reason: "attribution refused", suspend: false }),
        });

        const outcome = await drive(provider, { live: true });

        expect(providerErrorOf(outcome)).toMatchObject({ type: "provider", retryable: false });
        expect(outcome.deltas).toEqual([]);
        expect(model.doStreamCalls).toHaveLength(0);
    });
});

/**
 * The served id is read at the raw model boundary, not off the SDK's assembled
 * result: `streamText` falls back to the bound model's own id when the endpoint
 * reports none, so `response.modelId` would republish the requested id as an
 * endpoint's claim. A model double that reports no response metadata leaves the
 * served id absent even though the SDK would have filled it with `"fake-model"`.
 */
describe("model identity on the usage record", () => {
    async function recordOf(parts: LanguageModelV4StreamPart[]): Promise<LlmUsageRecord> {
        const { usageRecorder, records } = recordingUsage();
        const provider = createAiSdkProvider({ model: fakeModel(() => Promise.resolve({ stream: convertArrayToReadableStream(parts) })) });

        await runLoop(agentWith(), [{ role: "user", content: "hello" }], makeSession(), loopOptions(provider, { usageRecorder }));

        return presentAt(records, 0);
    }

    const answer: LanguageModelV4StreamPart[] = [
        { type: "text-start", id: "txt-1" },
        { type: "text-delta", id: "txt-1", delta: "done" },
        { type: "text-end", id: "txt-1" },
    ];

    it("reports the served model beside the requested one when the endpoint names it", async () => {
        const record = await recordOf([
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "resp-1", modelId: "fake-model-20260101" },
            ...answer,
            finishPart(),
        ]);

        expect(record.requestedModelId).toBe("fake-model");
        expect(record.servedModelId).toBe("fake-model-20260101");
    });

    it("leaves the served model absent when the endpoint reports no model id", async () => {
        const record = await recordOf([{ type: "stream-start", warnings: [] }, ...answer, finishPart()]);

        expect(record.requestedModelId).toBe("fake-model");
        expect(record).not.toHaveProperty("servedModelId");
    });

    it("keeps the model identity of a text-less turn", async () => {
        const record = await recordOf([
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "resp-1", modelId: "fake-model-20260101" },
            finishPart(),
        ]);

        expect(record.requestedModelId).toBe("fake-model");
        expect(record.servedModelId).toBe("fake-model-20260101");
    });
});

describe("stream error parts", () => {
    /** A stream that opens, then reports `error` the way a mid-turn failure does. */
    function erroringModel(error: unknown): MockLanguageModelV4 {
        return fakeModel(() =>
            Promise.resolve({
                stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
                    { type: "stream-start", warnings: [] },
                    { type: "error", error },
                ]),
            }),
        );
    }

    it("fails the call rather than returning the empty turn the parts describe", async () => {
        const outcome = await drive(createAiSdkProvider({ model: erroringModel(new Error("upstream exploded")), maxRetries: 0 }));

        const failure = providerErrorOf(outcome);
        expect(failure.type).toBe("provider");
        expect(failure.message).toContain("upstream exploded");
    });

    it("fails the call with the message of an overload in the stream, and the failure stays retryable", async () => {
        const outcome = await drive(createAiSdkProvider({ model: erroringModel({ type: "overloaded_error", message: "Overloaded" }), maxRetries: 0 }));

        const failure = providerErrorOf(outcome);
        expect(failure.retryable).toBe(true);
        // The bare payload reaches the message as its own text, never as
        // `[object Object]`.
        expect(failure.message).toContain("Overloaded");
    });

    it("reads a null-prototype stream error part the same way", async () => {
        // A proxied payload can arrive as a bare object with no prototype; the part
        // gate must still read its fields.
        const part: Record<string, unknown> = { type: "overloaded_error", message: "Overloaded" };
        Object.setPrototypeOf(part, null);

        const failure = providerErrorOf(await drive(createAiSdkProvider({ model: erroringModel(part), maxRetries: 0 })));

        expect(failure.retryable).toBe(true);
        expect(failure.message).toContain("Overloaded");
    });

    it("retries an error part before the first output part", async () => {
        let attempts = 0;
        const model = fakeModel(() => {
            attempts += 1;
            if (attempts > 1) return Promise.resolve(replyOf(["recovered"]));
            return Promise.resolve({
                stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
                    { type: "stream-start", warnings: [] },
                    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
                ]),
            });
        });

        const outcome = await drive(createAiSdkProvider({ model }), { live: true });

        expect(model.doStreamCalls).toHaveLength(2);
        expect(outcome.failure).toBeUndefined();
        expect(outcome.text).toBe("recovered");
    }, 10_000);
});

describe("failure logging", () => {
    const failures = (records: readonly LogRecord[]) => records.filter((record) => record.level === "error");

    it("records a call the envelope gave up on, thus the operator sees what the reply says", async () => {
        const { logger, records } = recordingLogger();
        const provider = createAiSdkProvider({
            model: fakeModel(() => Promise.reject(Object.assign(new Error("payment required"), { status: 402 }))),
            maxRetries: 0,
            logger,
        });

        expect((await drive(provider)).failure).toBeDefined();

        expect(failures(records)).toHaveLength(1);
        expect(presentAt(failures(records), 0).msg).toBe("provider call failed");
        expect(presentAt(failures(records), 0).fields).toMatchObject({ kind: "suspend", retryable: false, error: "payment required" });
    });

    it("records a live call that fails after its first output part", async () => {
        const { logger, records } = recordingLogger();
        const provider = createAiSdkProvider({ model: fakeModel(() => Promise.resolve(streamDeltaThenError("a", apiError503()))), logger });

        expect((await drive(provider, { live: true })).failure).toBeDefined();

        expect(failures(records).map((record) => record.msg)).toEqual(["provider call failed"]);
        expect(presentAt(failures(records), 0).fields).toMatchObject({ kind: "provider", retryable: true });
    });

    it("leaves a caller abort unrecorded, because a cancellation is not a failure", async () => {
        const { logger, records } = recordingLogger();
        const controller = new AbortController();
        const provider = createAiSdkProvider({
            model: fakeModel(() => {
                controller.abort();
                // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the abort reason rides as-is; the awaiter classifies the abort by its name.
                return Promise.reject(controller.signal.reason);
            }),
            maxRetries: 0,
            logger,
        });

        const outcome = await drive(provider, { signal: controller.signal });

        expect(outcome.aborted).toBe(true);
        expect(failures(records)).toHaveLength(0);
    });
});

describe("dropped thinking blocks", () => {
    const dropRecords = (records: readonly LogRecord[]) => records.filter((record) => record.msg === "thinking block dropped");

    // The harness passes each field of an entry through as it is, thus the
    // values here are only data to read back.
    const DROPS = [
        { type: "thinking", path: "messages.3.content.0", reason: "prefix_binding_mismatch" },
        { type: "thinking", path: "messages.5.content.0", reason: "model_binding_mismatch" },
    ];

    it("writes one warn record for each drop on a live call and on a buffered call, before the reader sees the finish", async () => {
        for (const live of [true, false]) {
            const { logger, records } = recordingLogger();
            const provider = createAiSdkProvider({
                model: replyingModel(["done"], finishPart({ providerMetadata: { anthropic: { inputTransformations: DROPS } } })),
                logger,
            });

            let recordsAtFinish: number | undefined;
            const outcome = await drive(provider, {
                live,
                onPart: (type) => {
                    if (type === "finish-step") recordsAtFinish = dropRecords(records).length;
                },
            });

            expect(outcome.failure).toBeUndefined();
            expect(recordsAtFinish).toBe(2);
            expect(dropRecords(records).map((record) => record.fields)).toEqual([
                { workload: "analysis:analysis-001", type: "thinking", path: "messages.3.content.0", reason: "prefix_binding_mismatch" },
                { workload: "analysis:analysis-001", type: "thinking", path: "messages.5.content.0", reason: "model_binding_mismatch" },
            ]);
        }
    });

    it("writes no drop record for a response without drops", async () => {
        const { logger, records } = recordingLogger();
        const provider = createAiSdkProvider({ model: replyingModel(), logger });

        await drive(provider);
        await drive(provider, { live: true });

        expect(dropRecords(records)).toEqual([]);
    });
});

describe("a reply that a fallback model served", () => {
    /**
     * A model can refuse a request by category, and the API then re-serves it on another
     * model. The `fallback` content block that reports the hop inside the turn never reaches
     * the harness, because the package drops it. Thus the harness cannot echo that turn as
     * the API produced it, and each signed thinking block of the turn is refused from the
     * next request on, with a 400 that no retry can pass.
     */
    const HOP = {
        anthropic: {
            iterations: [
                { type: "message", model: "claude-opus-5-5" },
                { type: "fallback_message", model: "claude-opus-4-8" },
            ],
        },
    };
    const NO_HOP = { anthropic: { iterations: [{ type: "message", model: "claude-opus-5-5" }] } };
    const THINKING = reasoning("weigh the two sets", "signed-by-the-api");

    const hopRecords = (records: readonly LogRecord[]) =>
        records.filter((record) => record.msg === "reply served by a fallback model, thus the harness drops the thinking of that turn");

    /**
     * The reply reports `claude-opus-5-5` as its own served id, because that is what the
     * API does across a hop: `message_start.message.model` keeps the requested model, and
     * only the iteration names the model that answered.
     */
    function servedReply(content: ScriptedReply["content"], providerMetadata: SharedV4ProviderMetadata): ScriptedReply {
        return { content, finishReason: "stop", providerMetadata, modelId: "claude-opus-5-5", usage: { inputTokens: 10, outputTokens: 2 } };
    }

    async function runOne(entry: ScriptedReply): Promise<{ messages: LoopMessage[]; record: LlmUsageRecord }> {
        const { provider } = scriptedModel([entry]);
        const { usageRecorder, records } = recordingUsage();
        const result = await runLoop(agentWith(), [{ role: "user", content: "hello" }], makeSession(), loopOptions(provider, { usageRecorder }));
        return { messages: result.messages, record: presentAt(records, 0) };
    }

    const partTypesOf = (message: LoopMessage | undefined): string[] => {
        if (message?.role !== "assistant") return [];
        return typeof message.content === "string" ? ["text"] : message.content.map((part) => part.type);
    };

    it("records the turn with no thinking, keeps every other part, and names the model that answered", async () => {
        const { messages, record } = await runOne(servedReply([THINKING, text("done")], HOP));

        expect(partTypesOf(messages.at(-1))).toEqual(["text"]);
        // The ledger of an embedder reads this field, thus the hop must reach it.
        expect(record.servedModelId).toBe("claude-opus-4-8");
        expect(record.requestedModelId).toBe("scripted-model");
    });

    it("keeps the served model of the response when the hop names no model", async () => {
        const unnamedHop = { anthropic: { iterations: [{ type: "message", model: "claude-opus-5-5" }, { type: "fallback_message" }] } };

        const { messages, record } = await runOne(servedReply([THINKING, text("done")], unnamedHop));

        expect(partTypesOf(messages.at(-1))).toEqual(["text"]);
        expect(record.servedModelId).toBe("claude-opus-5-5");
    });

    it("keeps the thinking when no iteration reports a hop", async () => {
        const { messages, record } = await runOne(servedReply([THINKING, text("done")], NO_HOP));

        expect(partTypesOf(messages.at(-1))).toEqual(["reasoning", "text"]);
        expect(record.servedModelId).toBe("claude-opus-5-5");
    });

    it("records no assistant message for a reply of nothing but thinking, because no part of it can be echoed", async () => {
        const { messages } = await runOne(servedReply([THINKING], HOP));

        expect(messages.map((message) => message.role)).toEqual(["user"]);
    });

    it("logs the hop on a live call and on a buffered call, and names the model that answered", async () => {
        for (const live of [true, false]) {
            const { logger, records } = recordingLogger();
            const provider = createAiSdkProvider({ model: replyingModel(["done"], finishPart({ providerMetadata: HOP })), logger });

            expect((await drive(provider, { live })).failure).toBeUndefined();

            expect(hopRecords(records).map((record) => record.fields)).toEqual([{ workload: "analysis:analysis-001", servedBy: "claude-opus-4-8" }]);
        }
    });

    it("logs no hop when no iteration reports one", async () => {
        const { logger, records } = recordingLogger();
        const provider = createAiSdkProvider({ model: replyingModel(["done"], finishPart({ providerMetadata: NO_HOP })), logger });

        await drive(provider);

        expect(hopRecords(records)).toEqual([]);
    });
});

describe("fallbackModelOf", () => {
    it("names the model of the fallback iteration", () => {
        expect(
            fallbackModelOf({
                anthropic: {
                    iterations: [
                        { type: "message", model: "a" },
                        { type: "fallback_message", model: "b" },
                    ],
                },
            }),
        ).toBe("b");
    });

    it("gives an empty name for a hop that names no model", () => {
        expect(fallbackModelOf({ anthropic: { iterations: [{ type: "fallback_message" }] } })).toBe("");
    });

    it("gives nothing when no iteration reports a hop, or when the metadata is of another vendor", () => {
        expect(fallbackModelOf({ anthropic: { iterations: [{ type: "message", model: "a" }] } })).toBeUndefined();
        expect(fallbackModelOf({ openai: { iterations: [{ type: "fallback_message", model: "b" }] } })).toBeUndefined();
        expect(fallbackModelOf(undefined)).toBeUndefined();
    });
});

describe("the warnings of the AI SDK", () => {
    it("reach the logger of the provider, and not the console", async () => {
        // The hook of the SDK is one process-global key, and the first provider of the
        // process installs it. The test installs its own provider in a clean slot, and
        // it gives the slot back.
        const previous: unknown = Reflect.get(globalThis, "AI_SDK_LOG_WARNINGS");
        Reflect.deleteProperty(globalThis, "AI_SDK_LOG_WARNINGS");
        try {
            const { logger, records } = recordingLogger();
            const warning = { type: "other", message: "the model ignored a setting" } as const;
            const provider = createAiSdkProvider({
                model: fakeModel(() =>
                    Promise.resolve({
                        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
                            { type: "stream-start", warnings: [warning] },
                            { type: "text-start", id: "txt-1" },
                            { type: "text-delta", id: "txt-1", delta: "ok" },
                            { type: "text-end", id: "txt-1" },
                            finishPart(),
                        ]),
                    }),
                ),
                logger,
            });

            await drive(provider);

            expect(records.filter((record) => record.msg === "ai sdk warning").map((record) => record.fields)).toEqual([
                { provider: "fake-provider", model: "fake-model", warning },
            ]);
        } finally {
            Reflect.set(globalThis, "AI_SDK_LOG_WARNINGS", previous);
        }
    });
});
