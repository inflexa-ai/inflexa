/**
 * The farm-extension seam on the profile deps (the data-profile-init spec).
 * A bound seam must ride through the projection into the profiler roster,
 * and an unbound seam must keep the current shape.
 */

import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import { makeFakeChatProvider, makeFakePool, makeFakeSandboxAgentDeps, makeFakeWorkspaceFs } from "../../agents/sandbox/__fixtures__/deps.js";
import { buildProfilerAgent } from "../../agents/sandbox/index.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import type { CatalogServices } from "../../catalog/equip.js";
import { createInMemoryCatalog } from "../../catalog/memory.js";
import type { ToolOutputStore } from "../../loop/tool-output.js";
import type { EmbeddingProvider } from "../../providers/types.js";

const unusedEmbedding: EmbeddingProvider = {
    dimensions: 1536,
    embed() {
        throw new Error("not used at composition time");
    },
};
import type { ExtendAnalysisFarm } from "../../sandbox/types.js";
import { profilerSandboxAgentDeps, type DataProfileDeps } from "../data-profile.js";
import { fakeLeases } from "../../sandbox/__fixtures__/leases.js";

const SERVICES: CatalogServices = { catalog: createInMemoryCatalog(), connectorBase: {} };

function makeProfileDeps(over: Partial<DataProfileDeps> = {}): DataProfileDeps {
    return {
        provider: makeFakeChatProvider(),
        pool: makeFakePool(),
        leases: fakeLeases(makeFakeSandboxAgentDeps().step.lease),
        workspaceFs: makeFakeWorkspaceFs(),
        resolveWorkspaceRoot: (resourceId: string) => Promise.resolve(`/tmp/sessions/${resourceId}`),
        model: "claude-opus-4-7",
        // The projection copies fields and calls nothing, so an empty stub is safe.
        runAuthorizer: createLocalRunAuthorizer(),
        services: SERVICES,
        // Same invariant: the composition never embeds.
        embedding: unusedEmbedding,
        ...over,
    };
}

describe("profilerSandboxAgentDeps — the farm-extension seam", () => {
    const step = makeFakeSandboxAgentDeps().step;
    const extendAnalysisFarm: ExtendAnalysisFarm = () => okAsync([]);

    it("a bound farm extension gives the profiler roster link_packages, and the system prompt does not change", async () => {
        const bound = await buildProfilerAgent(SERVICES, profilerSandboxAgentDeps(makeProfileDeps({ extendAnalysisFarm }), step));
        const unbound = await buildProfilerAgent(SERVICES, profilerSandboxAgentDeps(makeProfileDeps(), step));
        expect(bound.tools.map((t) => t.id)).toContain("link_packages");
        expect(bound.systemPrompt).toBe(unbound.systemPrompt);
    });

    it("with no farm extension bound, the profiler gets no link tool, and the composition does not throw", async () => {
        const def = await buildProfilerAgent(SERVICES, profilerSandboxAgentDeps(makeProfileDeps(), step));
        expect(def.tools.map((t) => t.id)).not.toContain("link_packages");
    });
});

describe("profilerSandboxAgentDeps — the tool output store", () => {
    const step = makeFakeSandboxAgentDeps().step;

    it("a store gives the profiler roster read_tool_output, and no store gives none", async () => {
        const toolOutputStore: ToolOutputStore = { put: () => okAsync(undefined), get: () => okAsync(null) };

        const withStore = await buildProfilerAgent(SERVICES, profilerSandboxAgentDeps(makeProfileDeps({ toolOutputStore }), step));
        const withoutStore = await buildProfilerAgent(SERVICES, profilerSandboxAgentDeps(makeProfileDeps(), step));

        expect(withStore.tools.map((t) => t.id)).toContain("read_tool_output");
        expect(withoutStore.tools.map((t) => t.id)).not.toContain("read_tool_output");
    });
});
