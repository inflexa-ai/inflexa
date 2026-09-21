/**
 * Knowledge barrel — the three tools of the knowledge plane and the client
 * seam they share.
 *
 * `createKnowledgeTools` gives the two planner tools when a client is bound,
 * and nothing when it is not. Absence is the default state of the open-source
 * host, and it is a normal condition: no tool attaches, no description enters
 * the context, and the planner works from the prose skills as it does today.
 * The template tool binds per step, because it needs the mutator of the step.
 */

import { createHash } from "node:crypto";

import type { Tool } from "../define-tool.js";
import type { WorkspaceMutator } from "../workspace/mutator.js";
import type { KnowledgeClient } from "./client.js";
import { createKnowledgeCheckTool } from "./check.js";
import { createSnapshotPin } from "./pin.js";
import { createKnowledgeRecommendTool, type KnowledgeRecommendDeps } from "./recommend.js";
import { createKnowledgeTemplateTool } from "./template.js";

export * from "./client.js";
export * from "./environment.js";
export * from "./local-slots.js";
export * from "./pin.js";
export * from "./skeleton.js";
export * from "./check.js";
export * from "./recommend.js";
export * from "./situation.js";
export * from "./template.js";

export interface KnowledgeToolsDeps {
    readonly client?: KnowledgeClient;
    /** Host path of the farm `inflexa.lock`, for the environment join of the recommend answer. */
    readonly farmLockFile?: string;
    /** Host path of the `image-packages.json` of the store, for the same join: the packages the sandbox image ships. */
    readonly imagePackagesFile?: string;
    /** Host path of the reference store, for the same join. */
    readonly refStorePath?: string;
    /** Receives each recommend answer the planner sees; see `KnowledgeRecommendDeps.onAnswer`. */
    readonly onRecommend?: KnowledgeRecommendDeps["onAnswer"];
}

/**
 * The planner tools: `knowledge_recommend` and `knowledge_check`, or an empty
 * list with no client. The two share one pin: the first recommend answer
 * fixes the release of the plan, and each later call carries it.
 */
export function createKnowledgeTools(deps: KnowledgeToolsDeps): Tool[] {
    if (!deps.client) return [];
    const pin = createSnapshotPin();
    return [
        createKnowledgeRecommendTool({
            client: deps.client,
            pin,
            ...(deps.farmLockFile ? { farmLockFile: deps.farmLockFile } : {}),
            ...(deps.imagePackagesFile ? { imagePackagesFile: deps.imagePackagesFile } : {}),
            ...(deps.refStorePath ? { refStorePath: deps.refStorePath } : {}),
            ...(deps.onRecommend ? { onAnswer: deps.onRecommend } : {}),
        }),
        createKnowledgeCheckTool({ client: deps.client, pin }),
    ];
}

/** A client that answers nothing: the definitions of the tools do not depend on the answers. */
const NO_CLIENT: KnowledgeClient = {
    recommend: async () => ({ match: "unavailable", reason: "no service" }),
    check: async () => ({ match: "unavailable", reason: "no service" }),
    render: async () => ({ match: "unavailable", reason: "no service" }),
    contract: async () => ({ match: "unavailable", reason: "no service" }),
};

/** A mutator that writes nothing: the definition of the template tool does not depend on the workspace. */
const NO_MUTATOR: WorkspaceMutator = {
    writeFile: async ({ path }) => ({ status: "out_of_scope", path }),
};

/**
 * The digest of the three tool definitions as this host registers them: the
 * id, the description, and the input schema of each, in id order. The
 * snapshot of the service pins its wire contract under its own tool
 * definition hash; this one names what the model saw, and a run records it,
 * thus a changed description or schema is a visible change of the run and
 * not a silent one.
 */
export function knowledgeToolDefinitionHash(): string {
    const tools = [...createKnowledgeTools({ client: NO_CLIENT }), createKnowledgeTemplateTool({ client: NO_CLIENT, mutator: NO_MUTATOR })];
    const definitions = tools.map((tool) => ({ id: tool.id, description: tool.description, schema: tool.jsonSchema })).sort((a, b) => (a.id < b.id ? -1 : 1));
    return `sha256:${createHash("sha256").update(JSON.stringify(definitions), "utf8").digest("hex")}`;
}
