/**
 * The sandbox agents: each executor and the data profiler, built from the catalog.
 *
 * A step agent keeps the prompt of the identity that its workflow wrote when it started, and it takes its tools from
 * the catalog at the time of the build. Thus a recovery keeps the instructions of the step and uses the tools that
 * are available then.
 */

import { builtinAgent, DEFAULT_EXECUTOR_ID } from "../../catalog/builtins.js";
import { equipAgent, equipAttachments, type CatalogServices } from "../../catalog/equip.js";
import { agentIdentityOf, resolveCatalog, type ResolvedAgent, type ResolvedCatalog } from "../../catalog/resolve.js";
import type { AgentIdentity } from "../../catalog/types.js";
import type { AgentDefinition } from "../../loop/types.js";
import { createSandboxAgent, type SandboxAgentDeps } from "./shared.js";

export { createSandboxAgent } from "./shared.js";
export type { SandboxAgentDeps, SandboxAgentSpec, SandboxStepCoords } from "./shared.js";
export { SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS } from "./types.js";

/**
 * The step agent of `agentId`. The prompt comes from the identity of the workflow input when the input has one. The
 * tools come from the catalog now: an agent that the catalog no longer holds runs with no attachments, and an input
 * with no identity runs on the catalog agent, or on the analyst when the catalog holds no such executor.
 */
/** The executor that a step of `agentId` runs on when its input has no identity: the catalog agent, else the analyst. */
function catalogExecutorOf(resolved: ResolvedCatalog, agentId: string): ResolvedAgent | undefined {
    const fromCatalog = resolved.agents.get(agentId);
    return fromCatalog?.role === "executor" ? fromCatalog : resolved.agents.get(DEFAULT_EXECUTOR_ID);
}

/**
 * The identity that the record of a step names: the identity of the input, else the identity of the catalog agent that
 * the step runs on. Undefined when the catalog holds no such executor and no fallback executor.
 */
export async function stepAgentIdentity(services: CatalogServices, agentId: string, identity: AgentIdentity | undefined): Promise<AgentIdentity | undefined> {
    if (identity !== undefined) return identity;
    const agent = catalogExecutorOf(await resolveCatalog(services.catalog), agentId);
    return agent === undefined ? undefined : agentIdentityOf(agent);
}

export async function buildStepAgent(
    services: CatalogServices,
    deps: SandboxAgentDeps,
    agentId: string,
    identity: AgentIdentity | undefined,
): Promise<AgentDefinition> {
    const resolved = await resolveCatalog(services.catalog);
    const fromCatalog = resolved.agents.get(agentId);
    const current = fromCatalog?.role === "executor" ? fromCatalog : undefined;
    if (identity !== undefined) {
        const equipment = await equipAttachments(services, resolved, current?.attachments ?? { connectors: [], mcp: [], skills: [] });
        return createSandboxAgent(deps, { id: identity.id, role: "executor", prompt: identity.prompt, equipment, defaultMaxSteps: current?.defaultMaxSteps });
    }
    const agent = catalogExecutorOf(resolved, agentId);
    if (agent === undefined || agent.prompt === undefined) throw new Error(`no executor "${agentId}" and no fallback executor`);
    const equipment = await equipAgent(services, resolved, agent);
    return createSandboxAgent(deps, { id: agent.id, role: "executor", prompt: agent.prompt, equipment, defaultMaxSteps: agent.defaultMaxSteps });
}

/** The data profiler with its attachments from the catalog. Its output is a JSON summary, thus no step standards. */
export async function buildProfilerAgent(services: CatalogServices, deps: SandboxAgentDeps): Promise<AgentDefinition> {
    const resolved = await resolveCatalog(services.catalog);
    const definition = builtinAgent("data-profiler");
    const attachments = resolved.agents.get(definition.id)?.attachments ?? definition.defaults;
    const equipment = await equipAttachments(services, resolved, attachments);
    // BuiltinAgent gives a prompt body to each executor and to the profiler.
    const prompt = definition.prompt ?? "";
    return createSandboxAgent(deps, { id: definition.id, role: "profiler", prompt, equipment }, { appendAnalysisStepStandards: false });
}
