import { describe, expect, it } from "bun:test";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import type { ChatProvider } from "../providers/types.js";
import { makeToolContext } from "./__fixtures__/tool-context.js";
import {
    AD_HOC_FALLBACK_AGENT_ID,
    AD_HOC_ROUTER_TIMEOUT_MS,
    defaultAdHocResources,
    effectiveAdHocTimeoutMs,
    routeAdHocRequest,
    validAdHocResources,
} from "./ad-hoc-router.js";

function providerReturning(input: Record<string, unknown>): ChatProvider {
    return {
        capabilities: { toolCalling: true },
        chat: () =>
            okAsync({
                message: {
                    role: "assistant",
                    content: [{ type: "tool-call", toolCallId: "route-1", toolName: "submit_route", input }],
                },
                finishReason: "tool-calls",
            }),
        chatStream: async function* () {},
    } as ChatProvider;
}

function providerWithoutRouteCall(): ChatProvider {
    return {
        capabilities: { toolCalling: true },
        chat: () => okAsync({ message: { role: "assistant", content: "not a tool call" }, finishReason: "stop" }),
        chatStream: async function* () {},
    } as ChatProvider;
}

function providerWaitingForAbort(): ChatProvider {
    return {
        capabilities: { toolCalling: true },
        chat: (_request, _session, signal) =>
            new ResultAsync(
                new Promise((resolve) => {
                    signal?.addEventListener("abort", () => resolve(err({ type: "aborted" } as never)), { once: true });
                }),
            ),
        chatStream: async function* () {},
    } as ChatProvider;
}

const emptyPool = {
    query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as Pool;

const policy = {
    perStep: { maxCpu: 8, maxMemoryGb: 16, maxGpuCount: 1 },
    budget: { cpu: 16, memoryGb: 32 },
};

describe("ad hoc routing", () => {
    it("uses a valid specialist and independently accepted resource recommendation", async () => {
        const { ctx } = makeToolContext();
        const route = await routeAdHocRequest(
            {
                provider: providerReturning({
                    agentId: "single-cell-agent",
                    resources: { cpu: 6, memoryGb: 12 },
                    rationale: "The request is a targeted single-cell comparison.",
                }),
                model: "utility-model",
                pool: emptyPool,
                resourcePolicy: policy,
            },
            {
                analysisId: "analysis-1",
                request: "Compare marker expression between the two cell clusters",
                session: ctx.session,
                signal: ctx.signal,
            },
        );

        expect(route.agentId).toBe("single-cell-agent");
        expect(route.resources).toEqual({ cpu: 6, memoryGb: 12 });
        expect(route.fallbackClass).toBeUndefined();
    });

    it("falls back to scientific-executor when the utility model selects no eligible specialist", async () => {
        const { ctx } = makeToolContext();
        const route = await routeAdHocRequest(
            {
                provider: providerReturning({
                    resources: { cpu: 2, memoryGb: 4 },
                    rationale: "No specialist matched.",
                }),
                model: "utility-model",
                pool: emptyPool,
                resourcePolicy: policy,
            },
            {
                analysisId: "analysis-1",
                request: "Run this targeted custom calculation",
                session: ctx.session,
                signal: ctx.signal,
            },
        );

        expect(route.agentId).toBe(AD_HOC_FALLBACK_AGENT_ID);
        expect(route.resources).toEqual({ cpu: 2, memoryGb: 4 });
        expect(route.fallbackClass).toBe("no_match");
    });

    it("defaults only invalid resources while preserving a valid specialist selection", async () => {
        const { ctx } = makeToolContext();
        const route = await routeAdHocRequest(
            {
                provider: providerReturning({
                    agentId: "cheminformatics-agent",
                    resources: { cpu: 99, memoryGb: 2 },
                    rationale: "The request is a targeted structure calculation.",
                }),
                model: "utility-model",
                pool: emptyPool,
                resourcePolicy: policy,
            },
            {
                analysisId: "analysis-1",
                request: "Calculate the molecular descriptors for these compounds",
                session: ctx.session,
                signal: ctx.signal,
            },
        );

        expect(route.agentId).toBe("cheminformatics-agent");
        expect(route.resources).toEqual(defaultAdHocResources(policy));
        expect(route.fallbackClass).toBe("invalid_resources");
    });

    it("rejects an unknown or fallback-only agent id while retaining valid resources", async () => {
        const { ctx } = makeToolContext();
        const route = await routeAdHocRequest(
            {
                provider: providerReturning({
                    agentId: "scientific-executor",
                    resources: { cpu: 3, memoryGb: 5 },
                }),
                model: "utility-model",
                pool: emptyPool,
                resourcePolicy: policy,
            },
            { analysisId: "analysis-1", request: "Custom calculation", session: ctx.session, signal: ctx.signal },
        );

        expect(route.agentId).toBe(AD_HOC_FALLBACK_AGENT_ID);
        expect(route.resources).toEqual({ cpu: 3, memoryGb: 5 });
        expect(route.fallbackClass).toBe("invalid_agent");
    });

    it("falls back deterministically on malformed and provider-error responses", async () => {
        const { ctx } = makeToolContext();
        const common = {
            model: "utility-model",
            pool: emptyPool,
            resourcePolicy: policy,
        };
        const malformed = await routeAdHocRequest(
            { ...common, provider: providerWithoutRouteCall() },
            { analysisId: "analysis-1", request: "Custom calculation", session: ctx.session, signal: ctx.signal },
        );
        const providerError = await routeAdHocRequest(
            {
                ...common,
                provider: {
                    capabilities: { toolCalling: true },
                    chat: () => errAsync({ type: "provider_failed" } as never),
                    chatStream: async function* () {},
                } as ChatProvider,
            },
            { analysisId: "analysis-1", request: "Custom calculation", session: ctx.session, signal: ctx.signal },
        );

        expect(malformed.fallbackClass).toBe("malformed");
        expect(providerError.fallbackClass).toBe("provider_error");
        expect(malformed.agentId).toBe(AD_HOC_FALLBACK_AGENT_ID);
        expect(providerError.agentId).toBe(AD_HOC_FALLBACK_AGENT_ID);
    });

    it("enforces the wall-clock timeout and uses bounded defaults when no policy is configured", async () => {
        const { ctx } = makeToolContext();
        const timedOut = await routeAdHocRequest(
            {
                provider: providerWaitingForAbort(),
                model: "utility-model",
                pool: emptyPool,
                timeoutMs: 1,
            },
            { analysisId: "analysis-1", request: "Custom calculation", session: ctx.session, signal: ctx.signal },
        );
        const absentPolicy = await routeAdHocRequest(
            {
                provider: providerReturning({ agentId: "network-agent", rationale: "Network request." }),
                model: "utility-model",
                pool: emptyPool,
            },
            { analysisId: "analysis-1", request: "Score this network", session: ctx.session, signal: ctx.signal },
        );

        expect(timedOut.fallbackClass).toBe("timeout");
        expect(timedOut.resources).toEqual({ cpu: 4, memoryGb: 8 });
        expect(absentPolicy.agentId).toBe("network-agent");
        expect(absentPolicy.resources).toEqual({ cpu: 4, memoryGb: 8 });
        expect(absentPolicy.fallbackClass).toBeUndefined();
    });
});

describe("effective ad hoc router timeout", () => {
    it("uses the advertised request-timeout limit when it is larger than the constant", () => {
        expect(effectiveAdHocTimeoutMs({ requestTimeoutMs: 30_000 })).toBe(30_000);
    });

    it("uses the default constant when the provider advertises nothing", () => {
        expect(effectiveAdHocTimeoutMs({})).toBe(AD_HOC_ROUTER_TIMEOUT_MS);
    });

    it("keeps the constant when the advertised limit is smaller than the constant", () => {
        expect(effectiveAdHocTimeoutMs({ requestTimeoutMs: 5_000 })).toBe(AD_HOC_ROUTER_TIMEOUT_MS);
    });

    it("lets an explicit deadline override the derived deadline", () => {
        expect(effectiveAdHocTimeoutMs({ requestTimeoutMs: 30_000 }, 1)).toBe(1);
    });
});

describe("ad hoc resource validation", () => {
    it("checks CPU, memory, and GPU bounds independently", () => {
        expect(validAdHocResources({ cpu: 4, memoryGb: 8, gpu: { count: 1 } }, policy)).toEqual({
            cpu: 4,
            memoryGb: 8,
            gpu: { count: 1 },
        });
        expect(validAdHocResources({ cpu: 9, memoryGb: 8 }, policy)).toBeNull();
        expect(validAdHocResources({ cpu: 4, memoryGb: 17 }, policy)).toBeNull();
        expect(validAdHocResources({ cpu: 4, memoryGb: 8, gpu: { count: 2 } }, policy)).toBeNull();
    });
});
