import { jsonSchema, tool as aiTool, type ToolCallPart } from "ai";
import type { Pool } from "pg";
import { z } from "zod";

import { PLANNABLE_AGENT_CATALOG } from "../agents/sandbox-catalog.js";
import { forSubAgent, type AgentSession } from "../auth/types.js";
import { DATA_PROFILE_ORIENTATION_MAX_CHARS, buildDataProfileOrientation } from "../app/data-profile-orientation.js";
import type { ResourcePolicy, ResourceSpec } from "../config/resource-limits.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import { resourceEstimationSection } from "../prompts/planner.js";
import type { ChatProvider } from "../providers/types.js";
import { loadDataProfileStatus } from "../state/index.js";

export const AD_HOC_ROUTER_AGENT_ID = "adhoc-router";
export const AD_HOC_ROUTER_TIMEOUT_MS = 10_000;
export const AD_HOC_FALLBACK_AGENT_ID = "scientific-executor";

const resourcesSchema = z.object({
    cpu: z.number().positive(),
    memoryGb: z.number().positive(),
    gpu: z.object({ count: z.number().int().positive() }).optional(),
});
const routeSchema = z.object({
    agentId: z.string().optional(),
    resources: resourcesSchema.optional(),
    rationale: z.string().optional(),
});

export interface AdHocRoute {
    readonly agentId: string;
    readonly resources: ResourceSpec;
    readonly rationale: string;
    readonly fallbackClass?: "timeout" | "provider_error" | "malformed" | "no_match" | "invalid_agent" | "invalid_resources";
}

export interface AdHocRouterDeps {
    readonly provider: ChatProvider;
    readonly model: string;
    readonly pool: Pool;
    readonly resourcePolicy?: ResourcePolicy;
    readonly logger?: Logger;
    /**
     * Test seam that sets an explicit deadline. An explicit value overrides the
     * derived deadline. The derived deadline is the maximum of
     * {@link AD_HOC_ROUTER_TIMEOUT_MS} and the request-timeout limit that the
     * provider advertises.
     */
    readonly timeoutMs?: number;
}

/**
 * The effective router deadline in milliseconds.
 *
 * An explicit value overrides the derived deadline. The derived deadline is the
 * maximum of {@link AD_HOC_ROUTER_TIMEOUT_MS} and the request-timeout limit that
 * the provider advertises.
 */
export function effectiveAdHocTimeoutMs(provider: Pick<ChatProvider, "requestTimeoutMs">, explicit?: number): number {
    return explicit ?? Math.max(AD_HOC_ROUTER_TIMEOUT_MS, provider.requestTimeoutMs ?? 0);
}

export function defaultAdHocResources(policy?: ResourcePolicy): ResourceSpec {
    return policy ? { cpu: Math.min(4, policy.perStep.maxCpu), memoryGb: Math.min(8, policy.perStep.maxMemoryGb) } : { cpu: 4, memoryGb: 8 };
}

export function validAdHocResources(value: unknown, policy?: ResourcePolicy): ResourceSpec | null {
    const parsed = resourcesSchema.safeParse(value);
    if (!parsed.success) return null;
    const r = parsed.data;
    const maxCpu = policy?.perStep.maxCpu ?? 4;
    const maxMemoryGb = policy?.perStep.maxMemoryGb ?? 8;
    const maxGpuCount = policy?.perStep.maxGpuCount ?? 0;
    if (r.cpu > maxCpu || r.memoryGb > maxMemoryGb || (r.gpu?.count ?? 0) > maxGpuCount) return null;
    return r;
}

function resourceBounds(policy?: ResourcePolicy): string {
    const defaults = defaultAdHocResources(policy);
    if (!policy) {
        return `CPU range 1..${defaults.cpu}; default ${defaults.cpu}. Memory range 1..${defaults.memoryGb} GB; default ${defaults.memoryGb}. GPU range 0..0.`;
    }
    const { perStep } = policy;
    return [
        `CPU range ${Math.min(1, perStep.maxCpu)}..${perStep.maxCpu}; default ${defaults.cpu}.`,
        `Memory range ${Math.min(1, perStep.maxMemoryGb)}..${perStep.maxMemoryGb} GB; default ${defaults.memoryGb}.`,
        `GPU range 0..${perStep.maxGpuCount}; omit gpu unless required.`,
    ].join(" ");
}

async function profileOrientation(pool: Pool, analysisId: string, logger: Logger): Promise<string> {
    try {
        const status = unwrapOrThrow(await loadDataProfileStatus(pool, analysisId));
        if (!status?.result) return "No persisted data-profile facts are available.";
        return buildDataProfileOrientation(status.result, DATA_PROFILE_ORIENTATION_MAX_CHARS);
    } catch (error) {
        logger.warn("could not load data profile for ad hoc routing", { error: error instanceof Error ? error.message : String(error) });
        return "The persisted data profile could not be loaded; route from the request alone.";
    }
}

function routeTool() {
    return {
        submit_route: aiTool({
            description: "Submit the single specialist and resource recommendation. This is the only valid response.",
            inputSchema: jsonSchema(z.toJSONSchema(routeSchema) as unknown as Parameters<typeof jsonSchema>[0]),
        }),
    };
}

export async function routeAdHocRequest(
    deps: AdHocRouterDeps,
    input: { analysisId: string; request: string; session: AgentSession; signal: AbortSignal },
): Promise<AdHocRoute> {
    const logger = (deps.logger ?? createNoopLogger()).named("adhoc-router").with({ analysisId: input.analysisId, model: deps.model });
    const catalog = PLANNABLE_AGENT_CATALOG.map(
        (agent) => `- ${agent.id}: capabilities [${agent.capabilities.join(", ")}]; suitable for [${agent.suitableFor.join(", ")}]`,
    ).join("\n");
    const orientation = await profileOrientation(deps.pool, input.analysisId, logger);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("ad hoc routing timed out")), effectiveAdHocTimeoutMs(deps.provider, deps.timeoutMs));
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let raw: unknown;
    let failure: AdHocRoute["fallbackClass"];
    try {
        const response = unwrapOrThrow(
            await deps.provider.chat(
                {
                    system: [
                        "Select exactly one specialist for a targeted one-step analysis and estimate its sandbox resources.",
                        "Choose only from the supplied catalog. Do not create a plan, reject the request, or select scientific-executor.",
                        resourceEstimationSection(deps.resourcePolicy),
                        resourceBounds(deps.resourcePolicy),
                        "Respond only by calling submit_route.",
                    ].join("\n\n"),
                    messages: [
                        {
                            role: "user",
                            content: `Request:\n${input.request}\n\nPersisted data-profile orientation:\n${orientation}\n\nEligible specialists:\n${catalog}`,
                        },
                    ],
                    tools: routeTool(),
                    toolChoice: { type: "tool", toolName: "submit_route" },
                },
                forSubAgent(input.session, AD_HOC_ROUTER_AGENT_ID),
                signal,
            ),
        );
        const call = Array.isArray(response.message.content)
            ? response.message.content.find((part): part is ToolCallPart => part.type === "tool-call" && part.toolName === "submit_route")
            : undefined;
        raw = call?.input;
        if (!call) failure = "malformed";
    } catch (error) {
        if (input.signal.aborted) throw error;
        failure = controller.signal.aborted && !input.signal.aborted ? "timeout" : "provider_error";
        logger.warn("ad hoc route fell back", { failure, error: error instanceof Error ? error.message : String(error) });
    } finally {
        clearTimeout(timer);
    }

    const candidate = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const requestedAgent = typeof candidate.agentId === "string" ? candidate.agentId : undefined;
    const validAgent = requestedAgent !== undefined && PLANNABLE_AGENT_CATALOG.some((agent) => agent.id === requestedAgent);
    const agentId = validAgent ? requestedAgent : AD_HOC_FALLBACK_AGENT_ID;
    if (!failure && !requestedAgent) failure = "no_match";
    if (!failure && !validAgent) failure = "invalid_agent";

    const validResources = validAdHocResources(candidate.resources, deps.resourcePolicy);
    const resources = validResources ?? defaultAdHocResources(deps.resourcePolicy);
    if (!validResources && candidate.resources !== undefined && !failure) failure = "invalid_resources";
    const rationale =
        typeof candidate.rationale === "string" && candidate.rationale.trim()
            ? candidate.rationale.trim()
            : failure
              ? `Deterministic fallback: ${failure}`
              : `Selected ${agentId}`;
    logger.info("ad hoc route selected", { agentId, resources, rationale, failure });
    return { agentId, resources, rationale, ...(failure ? { fallbackClass: failure } : {}) };
}
