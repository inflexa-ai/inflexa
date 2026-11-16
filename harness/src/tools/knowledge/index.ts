/**
 * Knowledge barrel — the tools of the knowledge plane and the client
 * interface they share.
 *
 * `createKnowledgeTools` gives the three planner tools when a client is bound,
 * and nothing when it is not. Absence is the default state of the open-source
 * host, and it is a normal condition: no tool attaches, no description enters
 * the context, and the planner works from the prose skills as it does today.
 * `run_template` binds per step, because it needs the mutator and the lease of
 * the step, and only a template step gets it.
 */

import { createHash } from "node:crypto";

import { err } from "neverthrow";

import type { EnvironmentStorePaths } from "../../config/environment-stores.js";
import type { BoundLease } from "../../sandbox/leases.js";
import type { Tool } from "../define-tool.js";
import type { WorkspaceMutator } from "../workspace/mutator.js";
import type { KnowledgeClient } from "./client.js";
import { createKnowledgeCheckTool } from "./check.js";
import { createClaimShelf, createKnowledgeClaimsTool } from "./claims.js";
import { createSnapshotPin } from "./pin.js";
import { createKnowledgeRecommendTool, type KnowledgeRecommendDeps } from "./recommend.js";
import { createRunTemplateTool } from "./run-template.js";

export * from "./client.js";
export * from "./claims.js";
export * from "./environment.js";
export * from "./local-slots.js";
export * from "./pin.js";
export * from "./skeleton.js";
export * from "./check.js";
export * from "./recommend.js";
export * from "./situation.js";
export * from "./run-template.js";

export type KnowledgeToolsDeps = {
    readonly client?: KnowledgeClient;
    /** Host path of the farm `inflexa.lock`, or its resolver for each analysis, for the environment join of the recommend answer. */
    readonly farmLockFile?: EnvironmentStorePaths["farmLockFile"];
    /** Host path of the `image-packages.json` of the store, for the same join: the packages the sandbox image ships. */
    readonly imagePackagesFile?: string;
    /** Host path of the reference store, for the same join. */
    readonly refStorePath?: string;
    /** The pool-scope inventory of the package store, for the same join: what a launch can link into the farm. */
    readonly readPoolInventory?: EnvironmentStorePaths["readPoolInventory"];
    /** Receives each recommend answer the planner sees; see `KnowledgeRecommendDeps.onAnswer`. */
    readonly onRecommend?: KnowledgeRecommendDeps["onAnswer"];
    /** Called for each answer of `knowledge_check`; see `KnowledgeCheckDeps.onCheck`. */
    readonly onCheck?: () => void;
};

/**
 * The planner tools: `knowledge_recommend`, `knowledge_claims`, and
 * `knowledge_check`, or an empty list with no client. The recommend tool and
 * the check share one pin: the first recommend answer fixes the release of
 * the plan, and each later call carries it. The recommend tool and the claims
 * tool share one shelf for the invocation: each answer keeps its claim views
 * there, and the claims tool reads them.
 */
export function createKnowledgeTools(deps: KnowledgeToolsDeps): Tool[] {
    if (!deps.client) return [];
    const pin = createSnapshotPin();
    const shelf = createClaimShelf();
    return [
        createKnowledgeRecommendTool({
            client: deps.client,
            pin,
            farmLockFile: deps.farmLockFile,
            imagePackagesFile: deps.imagePackagesFile,
            refStorePath: deps.refStorePath,
            readPoolInventory: deps.readPoolInventory,
            onAnswer: deps.onRecommend,
            shelf,
        }),
        createKnowledgeClaimsTool({ shelf }),
        createKnowledgeCheckTool({ client: deps.client, pin, onCheck: deps.onCheck }),
    ];
}

/** A client that answers nothing: the definitions of the tools do not depend on the answers. */
const NO_CLIENT: KnowledgeClient = {
    recommend: () => Promise.resolve({ match: "unavailable", reason: "no service" }),
    check: () => Promise.resolve({ match: "unavailable", reason: "no service" }),
    render: () => Promise.resolve({ match: "unavailable", reason: "no service" }),
    contract: () => Promise.resolve({ match: "unavailable", reason: "no service" }),
};

/** A mutator that writes nothing: the definition of the template tool does not depend on the workspace. */
const NO_MUTATOR: WorkspaceMutator = {
    writeFile: ({ path }) => Promise.resolve({ status: "out_of_scope", path }),
    recordWrite: () => undefined,
};

/** A lease that holds no sandbox: the definition of the template tool does not depend on it. */
const NO_LEASE: BoundLease = {
    acquire: () => Promise.resolve({ kind: "failed", detail: "no sandbox" }),
    release: () => Promise.resolve(),
    exec: () => Promise.resolve(err({ kind: "no_lease" })),
};

/**
 * The digest of the tool definitions as this host registers them: the
 * id, the description, and the input schema of each, in id order. The
 * snapshot of the service pins its wire contract under its own tool
 * definition hash; this one names what the model saw, and a run records it,
 * thus a changed description or schema is a visible change of the run and
 * not a silent one.
 */
export function knowledgeToolDefinitionHash(): string {
    const tools = [
        ...createKnowledgeTools({ client: NO_CLIENT }),
        createRunTemplateTool({ source: NO_CLIENT, template: "tpl-none", mutator: NO_MUTATOR, lease: NO_LEASE, workingDir: "/" }),
    ];
    const definitions = tools.map((tool) => ({ id: tool.id, description: tool.description, schema: tool.jsonSchema })).sort((a, b) => (a.id < b.id ? -1 : 1));
    return `sha256:${createHash("sha256").update(JSON.stringify(definitions), "utf8").digest("hex")}`;
}
export * from "./template-binding.js";
