/**
 * The agents under test: the conversation agent as the CLI composes it, with the
 * host tools of the CLI, the planner that `generate_plan` runs, and the report
 * agent of a report session. Each runs over deps that no tool reaches, and with
 * each tool swapped for a scripted one.
 *
 * A scripted tool keeps the id, the description, the JSON schema, and the
 * approval hook of the real tool, thus the model sees the same request as in
 * production, and the same calls ask the user. Only `execute` changes: it gives
 * the result that the case scripts, and it never touches a database, a sandbox,
 * or the network.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";

import { err, ok, okAsync } from "neverthrow";

import { createConversationAgent } from "@inflexa-ai/harness/agents/conversation-agent.js";
import { createReportSessionAgent } from "@inflexa-ai/harness/agents/report-session-agent.js";
import { createNoopLogger } from "@inflexa-ai/harness/lib/console-logger.js";
import { analogyAgentOf } from "@inflexa-ai/harness/tools/research/generate-analogy-report.js";
import { buildPlannerSearchTools, plannerAgentOf, plannerTerminalTools, type GeneratePlanDeps } from "@inflexa-ai/harness/tools/research/generate-plan.js";
import { makeFakeWorkspaceFs } from "@inflexa-ai/harness/agents/sandbox/__fixtures__/deps.js";
import { createLocalRunAuthorizer } from "@inflexa-ai/harness/auth/local-run-authorizer.js";
import { unusedCitationResolver } from "@inflexa-ai/harness/citations/__fixtures__/resolver.js";
import type { ExecuteAnalysisResult } from "@inflexa-ai/harness/workflows/execute-analysis.js";
import type { EnsureSessionStateResult } from "@inflexa-ai/harness/app/report-session-runtime.js";
import type { RunLauncher } from "@inflexa-ai/harness/execution/run-launcher.js";
import { createPool } from "@inflexa-ai/harness/lib/storage.js";
import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";
import { inProcessSubAgent } from "@inflexa-ai/harness/loop/sub-agent.js";
import type { ToolOutputStore } from "@inflexa-ai/harness/loop/tool-output.js";
import type { AgentDefinition } from "@inflexa-ai/harness/loop/types.js";
import { unusedChatProvider } from "@inflexa-ai/harness/providers/__fixtures__/chat-provider.js";
import type { EmbeddingProvider } from "@inflexa-ai/harness/providers/types.js";
import type { AskRequest } from "@inflexa-ai/harness/tools/approval/contract.js";
import type { Tool } from "@inflexa-ai/harness/tools/define-tool.js";
import type { WebSearchEngine } from "@inflexa-ai/harness/tools/research/web-search.js";

import { createRunInflexaTool } from "../../cli/src/modules/harness/inflexa_tool.ts";
import { createManageInputsTool } from "../../cli/src/modules/harness/inputs_tool.ts";
import { createLaunchDirTool } from "../../cli/src/modules/harness/launch_dir_tool.ts";

/** What a scripted tool gives: an ok value, or an error that the model reads. */
export type ScriptedResult = { readonly ok: unknown } | { readonly error: string };

/** A script that keeps the real tool, for a tool whose `execute` is pure, such as the check of `submit_plan`. */
export const REAL_TOOL = "real";

/** The scripted result of a call, from its input. A tool with no script gives {@link UNSCRIPTED_ERROR}. */
export type ToolScript = ScriptedResult | ((input: unknown) => ScriptedResult) | typeof REAL_TOOL;

/** The agents that a case can run. A sandbox agent is built for each trial, over the tree of the trial. */
export type AgentKind = "conversation" | "planner" | "report" | "analogy" | "sandbox";

/** The agents that one composition serves for the whole run. */
export type StaticAgentKind = Exclude<AgentKind, "sandbox">;

export const UNSCRIPTED_ERROR = "This tool is not available now.";

function refuse(): never {
    throw new Error("an eval agent never reaches this dependency");
}

const unusedEmbedding: EmbeddingProvider = { dimensions: 1536, embed: refuse };
const unusedRunLauncher: RunLauncher = { launch: refuse };
const unusedWebSearch: WebSearchEngine = { search: refuse };
const unusedToolOutputStore: ToolOutputStore = { put: () => okAsync(undefined), get: () => okAsync(null) };

const REPO = join(import.meta.dir, "..", "..");

/**
 * Refuse a CLI that resolves a harness other than the one of this checkout. The host tools import the bare
 * `@inflexa-ai/harness`, which no plugin maps (see `harness-source.ts`), and the npm release of the
 * CLI install drops their approval hooks. Thus each approval case would grade a tool that never asks.
 */
function assertCliLinksWorkingHarness(): void {
    const resolved = realpathSync(Bun.resolveSync("@inflexa-ai/harness", join(REPO, "cli", "src")));
    const harness = realpathSync(join(REPO, "harness"));
    if (!resolved.startsWith(`${harness}/`)) {
        throw new Error(`the CLI resolves @inflexa-ai/harness to ${resolved}, not to the harness of this checkout. Run \`bun run harness:local\` in cli/.`);
    }
}

/**
 * The host tools of the CLI (`cli/src/modules/harness/runtime.ts`, `hostTools`), minus
 * `knowledge_recommend`, which the CLI attaches only when a knowledge endpoint is configured.
 */
function cliHostTools(): Tool[] {
    assertCliLinksWorkingHarness();
    // Each factory gives a `Tool` of its own input type. The loop reads a tool through the erased
    // `Tool` shape only, the same as the `hostTools` list of the CLI.
    return [createRunInflexaTool(), createLaunchDirTool(), createManageInputsTool()] as unknown as Tool[];
}

/** The pool of the agent. It never connects, because no tool of the agent runs. */
function unconnectedPool(): ReturnType<typeof createPool> {
    return createPool({ host: "eval.invalid", port: "5432", database: "eval", user: "eval", password: "eval", sslMode: "disable" });
}

/** The conversation agent as the CLI composes it. */
export function conversationAgent(): AgentDefinition {
    return createConversationAgent({
        provider: unusedChatProvider(),
        registerSubAgent: inProcessSubAgent,
        utilityProvider: unusedChatProvider(),
        pool: unconnectedPool(),
        embedding: unusedEmbedding,
        workspaceFs: makeFakeWorkspaceFs(),
        model: "eval",
        utilityModel: "eval",
        executeAnalysisWorkflow: (): Promise<ExecuteAnalysisResult> => refuse(),
        anchorReportSession: (): Promise<EnsureSessionStateResult> => refuse(),
        resolveWorkspaceRoot: (id: string) => Promise.resolve(join("/eval", id)),
        runAuthorizer: createLocalRunAuthorizer(),
        runLauncher: unusedRunLauncher,
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        skillsDir: "/eval/skills",
        chrome: {},
        citationResolver: unusedCitationResolver,
        toolOutputStore: unusedToolOutputStore,
        webSearch: unusedWebSearch,
        hostTools: cliHostTools(),
    });
}

/** The planner that `generate_plan` runs, with the terminal tools of a run with no knowledge answer. */
export function plannerAgent(): AgentDefinition {
    const deps: GeneratePlanDeps = {
        conversation: { provider: unusedChatProvider(), model: "eval" },
        pool: unconnectedPool(),
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        refStorePath: "/eval/refs",
        farmLockFile: "/eval/farm.lock",
        imagePackagesFile: "/eval/image-packages.json",
        toolOutputStore: unusedToolOutputStore,
    };
    return plannerAgentOf(deps, buildPlannerSearchTools(deps), plannerTerminalTools(undefined, createNoopLogger()));
}

/** The report agent of a report session. Each tool is scripted, thus no dependency below is reached. */
export function reportAgent(): AgentDefinition {
    const unused = (): never => refuse();
    return createReportSessionAgent({
        model: "eval",
        pool: unconnectedPool(),
        embedding: unusedEmbedding,
        workspaceFs: makeFakeWorkspaceFs(),
        gateway: { load: unused, persist: unused, stampRendered: unused, stampSeen: unused },
        resolveWorkspaceRoot: (id: string) => Promise.resolve(join("/eval", id)),
        store: { record: unused, getVersion: unused, getThreadVersion: unused },
        threads: { getThread: unused, setAutoTitle: unused },
        chrome: {},
        derivations: { appendDerivation: unused },
        toolOutputStore: unusedToolOutputStore,
    });
}

/** The analogical reasoner that `generate_analogy_report` runs. */
export function analogyAgent(): AgentDefinition {
    return analogyAgentOf({ model: "eval", bioKeys: { drugbank: "", disgenet: "", epaCcte: "" }, toolOutputStore: unusedToolOutputStore });
}

/** The agent of each kind. */
export function evalAgents(): Readonly<Record<StaticAgentKind, AgentDefinition>> {
    return { conversation: conversationAgent(), planner: plannerAgent(), report: reportAgent(), analogy: analogyAgent() };
}

/**
 * The approval of a tool whose real hook reads the state of the CLI. The hook of `manage_inputs` reads
 * the inputs of the analysis from the database of the user, thus the eval asks for each add and each
 * remove, which is what the real hook does for a change.
 */
const SCRIPTED_APPROVALS: Readonly<Record<string, (input: unknown) => AskRequest | undefined>> = {
    manage_inputs: (input) => {
        const record = parseUnknownRecord(input);
        if (record === undefined || record.action === "list") return undefined;
        return { title: "Change the inputs", command: JSON.stringify(record) };
    },
};

function scriptedTool(tool: Tool, script: ToolScript | undefined): Tool {
    if (script === REAL_TOOL) return tool;
    const scriptedApproval = SCRIPTED_APPROVALS[tool.id];
    const approval = scriptedApproval === undefined ? tool.approval : (input: unknown) => scriptedApproval(input);
    return {
        id: tool.id,
        description: tool.description,
        inputSchema: tool.inputSchema,
        jsonSchema: tool.jsonSchema,
        ...(approval === undefined ? {} : { approval }),
        execute: (input) => {
            const result = script === undefined ? { error: UNSCRIPTED_ERROR } : typeof script === "function" ? script(input) : script;
            return Promise.resolve("ok" in result ? ok(result.ok) : err({ error: result.error, retryable: false }));
        },
    };
}

/**
 * The tools of a sandbox agent that stay real in a trial. They read and write the tree of the trial, the lock of its
 * farm, and the skills of the repository, and an exec reaches only the scripted client. Each other tool reads a
 * database or the network, thus it is scripted.
 */
const SANDBOX_REAL_TOOLS = new Set([
    "execute_command",
    "write_file",
    "edit_file",
    "read_file",
    "list_files",
    "file_stat",
    "grep",
    "list_available_packages",
    "link_packages",
    "skill_search",
    "skill_read",
    "report_blocker",
    "read_tool_output",
    "submit_file_metadata",
    "scan_inputs",
    "submit_profile",
]);

/** A sandbox agent with each tool that the case scripts, and each tool outside {@link SANDBOX_REAL_TOOLS}, scripted. */
export function withSandboxScripts(agent: AgentDefinition, scripts: Readonly<Record<string, ToolScript>>): AgentDefinition {
    const ids = new Set(agent.tools.map((tool) => tool.id));
    const unknown = Object.keys(scripts).filter((id) => !ids.has(id));
    if (unknown.length > 0) throw new Error(`the agent ${agent.id} has no tool ${unknown.join(", ")}`);
    return {
        ...agent,
        tools: agent.tools.map((tool) => (scripts[tool.id] === undefined && SANDBOX_REAL_TOOLS.has(tool.id) ? tool : scriptedTool(tool, scripts[tool.id]))),
    };
}

/**
 * The agent with each tool and each script tool scripted. A script for a tool that the agent does not hold is a fault
 * of the case.
 */
export function withScriptedTools(agent: AgentDefinition, scripts: Readonly<Record<string, ToolScript>>): AgentDefinition {
    const scriptTools = agent.scriptTools ?? [];
    const ids = new Set([...agent.tools, ...scriptTools].map((tool) => tool.id));
    const unknown = Object.keys(scripts).filter((id) => !ids.has(id));
    if (unknown.length > 0) throw new Error(`the agent ${agent.id} has no tool ${unknown.join(", ")}`);
    return {
        ...agent,
        tools: agent.tools.map((tool) => scriptedTool(tool, scripts[tool.id])),
        scriptTools: scriptTools.map((tool) => scriptedTool(tool, scripts[tool.id])),
    };
}
