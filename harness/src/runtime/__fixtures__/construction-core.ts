/**
 * Construction-only dep bags for the runtime tests: every required member is
 * present so the assembly builds, and no workflow or agent ever runs, so every
 * seam that only a run would touch throws and names itself.
 */

import { Pool } from "pg";

import { makeFakeSandboxClient, makeFakeWorkspaceFs } from "../../agents/sandbox/__fixtures__/deps.js";
import { createNoopRunCharge } from "../../billing/noop-run-charge.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import { createNoopArtifactRegistry } from "../../execution/noop-artifact-registry.js";
import type { RunLauncher } from "../../execution/run-launcher.js";
import { unusedChatProvider } from "../../providers/__fixtures__/chat-provider.js";
import type { EmbeddingProvider } from "../../providers/types.js";
import type { CoreWorkflowDeps } from "../assemble.js";

/** A seam no case drives: the first call throws and names the seam. */
export function refuse(seam: string): never {
    throw new Error(`${seam}: not driven by this test`);
}

export function refuseEmbedding(): EmbeddingProvider {
    return { dimensions: 3, embed: () => refuse("embedding") };
}

export function refuseRunLauncher(): RunLauncher {
    return { launch: () => refuse("runLauncher") };
}

export function constructionSandboxStepDeps(): CoreWorkflowDeps["sandboxStep"] {
    return {
        pool: new Pool(),
        provider: unusedChatProvider(),
        embedding: refuseEmbedding(),
        sandboxClient: makeFakeSandboxClient(),
        artifactRegistry: createNoopArtifactRegistry(),
        workspaceFs: makeFakeWorkspaceFs(),
        resolveWorkspaceRoot: async () => "/tmp/sessions/analysis-001",
        model: "test/model",
        buildAgent: () => refuse("buildAgent"),
        resolveWritePrefix: () => refuse("resolveWritePrefix"),
    };
}

export function constructionExecuteAnalysisDeps(): ReturnType<CoreWorkflowDeps["buildExecuteAnalysis"]> {
    return {
        pool: new Pool(),
        provider: unusedChatProvider(),
        embedding: refuseEmbedding(),
        sandboxStepCallable: () => refuse("sandboxStepCallable"),
        resolveWorkspaceRoot: async () => "/tmp/sessions/analysis-001",
        synthesisModel: "test/model",
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        runCharge: createNoopRunCharge(),
        runAuthorizer: createLocalRunAuthorizer(),
    };
}

export function constructionDataProfileDeps(): CoreWorkflowDeps["dataProfile"] {
    return {
        provider: unusedChatProvider(),
        pool: new Pool(),
        sandboxClient: makeFakeSandboxClient(),
        workspaceFs: makeFakeWorkspaceFs(),
        resolveWorkspaceRoot: async () => "/tmp/sessions/analysis-001",
        model: "test/model",
        runAuthorizer: createLocalRunAuthorizer(),
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        embedding: refuseEmbedding(),
        skillsDir: "/skills",
    };
}

export function constructionWorkflows(): CoreWorkflowDeps {
    return {
        sandboxStep: constructionSandboxStepDeps(),
        buildExecuteAnalysis: () => constructionExecuteAnalysisDeps(),
        dataProfile: constructionDataProfileDeps(),
    };
}
