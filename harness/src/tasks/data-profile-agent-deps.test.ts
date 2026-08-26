/**
 * The farm-extension seam on the profile deps (the data-profile-init spec).
 * A bound seam must ride through the projection into the profiler roster,
 * and an unbound seam must keep the current shape.
 */

import { describe, expect, it } from "bun:test";

import {
    makeFakeChatProvider,
    makeFakePool,
    makeFakeSandboxAgentDeps,
    makeFakeSandboxClient,
    makeFakeWorkspaceFs,
} from "../agents/sandbox/__fixtures__/deps.js";
import { createDataProfilerAgent } from "../agents/sandbox/data-profiler.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { EmbeddingProvider } from "../providers/types.js";
import { sandboxPackageLinkPrompt } from "../prompts/sandbox-standards.js";
import type { ExtendAnalysisFarm } from "../sandbox/types.js";
import { profilerSandboxAgentDeps, type DataProfileDeps } from "./data-profile.js";

function makeProfileDeps(over: Partial<DataProfileDeps> = {}): DataProfileDeps {
    return {
        provider: makeFakeChatProvider(),
        pool: makeFakePool(),
        sandboxClient: makeFakeSandboxClient(),
        workspaceFs: makeFakeWorkspaceFs(),
        resolveWorkspaceRoot: (resourceId: string) => `/tmp/sessions/${resourceId}`,
        model: "claude-opus-4-7",
        // The projection copies fields and calls nothing, so an empty stub is safe.
        runAuthorizer: {} as RunAuthorizer,
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        // Same invariant: the composition never embeds.
        embedding: {} as EmbeddingProvider,
        skillsDir: "/tmp/skills",
        ...over,
    };
}

describe("profilerSandboxAgentDeps — the farm-extension seam", () => {
    const step = makeFakeSandboxAgentDeps().step;
    const extendAnalysisFarm: ExtendAnalysisFarm = async () => [];

    it("a bound seam gives the profiler roster link_packages, with the link prompt layer", () => {
        const def = createDataProfilerAgent(profilerSandboxAgentDeps(makeProfileDeps({ extendAnalysisFarm }), step));
        expect(def.tools.map((t) => t.id)).toContain("link_packages");
        expect(def.systemPrompt).toContain(sandboxPackageLinkPrompt.trim());
    });

    it("an unbound seam gives no link tool and no prompt layer, and the composition does not throw", () => {
        const def = createDataProfilerAgent(profilerSandboxAgentDeps(makeProfileDeps(), step));
        expect(def.tools.map((t) => t.id)).not.toContain("link_packages");
        expect(def.systemPrompt).not.toContain(sandboxPackageLinkPrompt.trim());
    });
});
