import { describe, expect, it } from "bun:test";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import type { ChatProvider } from "../providers/types.js";
import { makeToolContext } from "./__fixtures__/tool-context.js";
import { AD_HOC_FALLBACK_AGENT_ID, defaultAdHocResources, routeAdHocRequest, validAdHocResources } from "./ad-hoc-router.js";

function providerReturning(input: Record<string, unknown>, capture?: { system?: string }): ChatProvider {
    return {
        capabilities: { toolCalling: true },
        chat: (request: { system: string }) => {
            if (capture) capture.system = request.system;
            return okAsync({
                message: {
                    role: "assistant",
                    content: [{ type: "tool-call", toolCallId: "route-1", toolName: "submit_route", input }],
                },
                finishReason: "tool-calls",
            });
        },
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

describe("ad hoc routing — the packages of the step", () => {
    it("carries the entries of the route, and teaches the one grammar in its prompt", async () => {
        const { ctx } = makeToolContext();
        const capture: { system?: string } = {};
        const route = await routeAdHocRequest(
            {
                provider: providerReturning(
                    {
                        agentId: "single-cell-agent",
                        resources: { cpu: 4, memoryGb: 8 },
                        rationale: "A targeted clustering comparison.",
                        packages: ["scanpy", "python:igraph"],
                    },
                    capture,
                ),
                model: "utility-model",
                pool: emptyPool,
                resourcePolicy: policy,
            },
            { analysisId: "analysis-1", request: "Cluster these cells and score the markers", session: ctx.session, signal: ctx.signal },
        );

        expect(route.packages).toEqual(["scanpy", "python:igraph"]);
        expect(route.droppedPackages).toEqual([]);
        // The prefixed form is the remedy for a both-track name, and the router
        // writes it from the request alone — it holds no census to read it from.
        expect(capture.system).toContain('"python:igraph"');
        expect(capture.system).toContain("the language of the specialist you select and the wording of the request decide the track");
    });

    it("drops an entry that is not a query, and keeps the specialist and the resources", async () => {
        const { ctx } = makeToolContext();
        const route = await routeAdHocRequest(
            {
                provider: providerReturning({
                    agentId: "cheminformatics-agent",
                    resources: { cpu: 6, memoryGb: 12 },
                    rationale: "A targeted descriptor calculation.",
                    packages: ["rdkit", "./wheels/rdkit-2024.9.1.whl"],
                }),
                model: "utility-model",
                pool: emptyPool,
                resourcePolicy: policy,
            },
            { analysisId: "analysis-1", request: "Calculate the descriptors", session: ctx.session, signal: ctx.signal },
        );

        expect(route.packages).toEqual(["rdkit"]);
        expect(route.droppedPackages).toEqual([{ entry: "./wheels/rdkit-2024.9.1.whl", reason: "unparsable" }]);
        // A package failure is its own axis: the route itself did not fall back.
        expect(route.agentId).toBe("cheminformatics-agent");
        expect(route.resources).toEqual({ cpu: 6, memoryGb: 12 });
        expect(route.fallbackClass).toBeUndefined();
    });

    it("keeps a present name, rewrites a missed spelling once, and drops a name the pool does not hold", async () => {
        const { ctx } = makeToolContext();
        const route = await routeAdHocRequest(
            {
                provider: providerReturning({
                    agentId: "single-cell-agent",
                    resources: { cpu: 4, memoryGb: 8 },
                    rationale: "A targeted integration.",
                    packages: ["scanpy", "seurat", "SEURAT", "r:seurat==5.0.0", "MOFA2"],
                }),
                model: "utility-model",
                pool: emptyPool,
                resourcePolicy: policy,
                resolvePackages: async (names) =>
                    names.map((requested) =>
                        requested === "scanpy"
                            ? { requested, present: true as const, name: "scanpy", section: "Python (pip)", version: "1.10.0" }
                            : requested === "MOFA2"
                              ? { requested, present: false as const }
                              : { requested, present: false as const, suggestion: "Seurat" },
                    ),
            },
            { analysisId: "analysis-1", request: "Integrate these datasets", session: ctx.session, signal: ctx.signal },
        );

        // Only the spelling missed, thus the rewrite keeps the track and the
        // version of the ask. Two entries that take one spelling are one ask,
        // and the step must not name that package twice.
        expect(route.packages).toEqual(["scanpy", "Seurat", "r:Seurat==5.0.0"]);
        expect(route.droppedPackages).toEqual([{ entry: "MOFA2", reason: "absent" }]);
    });

    it("keeps every parsed entry when the resolution cannot answer, and gives an empty list for a missing field", async () => {
        const { ctx } = makeToolContext();
        const common = { model: "utility-model", pool: emptyPool, resourcePolicy: policy };
        const unavailable = await routeAdHocRequest(
            {
                ...common,
                provider: providerReturning({
                    agentId: "network-agent",
                    resources: { cpu: 4, memoryGb: 8 },
                    packages: ["scanpy", "MOFA2"],
                }),
                resolvePackages: async () => null,
            },
            { analysisId: "analysis-1", request: "Score this network", session: ctx.session, signal: ctx.signal },
        );
        const noField = await routeAdHocRequest(
            { ...common, provider: providerReturning({ agentId: "network-agent", resources: { cpu: 4, memoryGb: 8 } }) },
            { analysisId: "analysis-1", request: "Score this network", session: ctx.session, signal: ctx.signal },
        );

        // An inventory that cannot answer says nothing about a package, thus
        // the link pass judges every entry at launch.
        expect(unavailable.packages).toEqual(["scanpy", "MOFA2"]);
        expect(unavailable.droppedPackages).toEqual([]);
        expect(noField.packages).toEqual([]);
        expect(noField.droppedPackages).toEqual([]);
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
