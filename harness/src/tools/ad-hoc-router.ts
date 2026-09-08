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
import { packagesSection, resourceEstimationSection } from "../prompts/planner.js";
import { effectiveDeadlineMs, type ChatProvider } from "../providers/types.js";
import { formatQuery, parseQuery, type PackageQuery } from "../sandbox/package-identity.js";
import { loadDataProfileStatus } from "../state/index.js";
import type { CheckedPackage } from "./sandbox/list-available-packages.js";

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
    packages: z.array(z.string()).optional(),
});

/**
 * A package entry that the step does not carry.
 *
 * - `unparsable` — the entry is not a query of the one grammar.
 * - `absent` — the bound resolution answered that the pool holds no such
 *   package, and it offered no other spelling.
 */
export interface DroppedPackage {
    readonly entry: string;
    readonly reason: "unparsable" | "absent";
}

export interface AdHocRoute {
    readonly agentId: string;
    readonly resources: ResourceSpec;
    readonly rationale: string;
    /** The validated package entries of the step. Empty is a normal answer. */
    readonly packages: readonly string[];
    /** Every entry that the validation removed, with the reason for the caveat. */
    readonly droppedPackages: readonly DroppedPackage[];
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
    /**
     * A targeted presence check of the names that the route emits. `null` means
     * that the inventory could not answer at all, and every parsed entry then
     * stays — an unreadable inventory says nothing about a package. Unbound,
     * the entries reach the link pass as the model wrote them.
     */
    readonly resolvePackages?: (names: readonly string[]) => Promise<readonly CheckedPackage[] | null>;
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
        return buildDataProfileOrientation(status.result, analysisId, DATA_PROFILE_ORIENTATION_MAX_CHARS);
    } catch (error) {
        logger.warn("could not load data profile for ad hoc routing", { error: error instanceof Error ? error.message : String(error) });
        return "The persisted data profile could not be loaded; route from the request alone.";
    }
}

/** The spelling that the pool holds for a missed entry, where the resolution offers one. */
function suggestedSpelling(rows: readonly CheckedPackage[]): string | undefined {
    for (const row of rows) {
        if (!row.present && row.suggestion !== undefined) return row.suggestion;
    }
    return undefined;
}

/**
 * Validate the package entries of a route on their own axis: a bad entry costs
 * that entry and nothing else, because the specialist and the resources are
 * sound without it.
 *
 * A guess of a model reaches here, and no person reviewed it. Thus a name that
 * the pool does not hold leaves the step with a caveat, where the same name in
 * a plan step — which a person approved — refuses the launch instead.
 */
async function routePackages(
    raw: unknown,
    resolve: AdHocRouterDeps["resolvePackages"],
    logger: Logger,
): Promise<{ packages: string[]; droppedPackages: DroppedPackage[] }> {
    const entries: readonly unknown[] = Array.isArray(raw) ? raw : [];
    const droppedPackages: DroppedPackage[] = [];
    const kept: { entry: string; query: PackageQuery }[] = [];
    const seen = new Set<string>();
    for (const element of entries) {
        if (typeof element !== "string") {
            droppedPackages.push({ entry: String(element), reason: "unparsable" });
            continue;
        }
        const entry = element.trim();
        const parsed = parseQuery(entry);
        if (parsed.isErr()) {
            droppedPackages.push({ entry, reason: "unparsable" });
            continue;
        }
        // Two equal entries are one ask, and the link pass unions them anyway.
        if (seen.has(entry)) continue;
        seen.add(entry);
        kept.push({ entry, query: parsed.value });
    }
    const asWritten = (): string[] => kept.map((candidate) => candidate.entry);
    if (!resolve || kept.length === 0) return { packages: asWritten(), droppedPackages };

    let rows: readonly CheckedPackage[] | null;
    try {
        rows = await resolve(asWritten());
    } catch (error) {
        // A resolution that throws is the same condition as an inventory that
        // reports itself unavailable: it says nothing about the packages.
        logger.warn("ad hoc package resolution failed", { error: error instanceof Error ? error.message : String(error) });
        rows = null;
    }
    if (rows === null) return { packages: asWritten(), droppedPackages };

    const packages: string[] = [];
    const emitted = new Set<string>();
    for (const { entry, query } of kept) {
        // One name that both tracks hold answers with one row per track, thus a
        // present row anywhere in the answer keeps the entry as it was written.
        // The link pass then refuses the bare form with the two prefixed ones.
        const answer = rows.filter((row) => row.requested === entry);
        const held = answer.length === 0 || answer.some((row) => row.present);
        const suggestion = held ? undefined : suggestedSpelling(answer);
        if (!held && suggestion === undefined) {
            droppedPackages.push({ entry, reason: "absent" });
            continue;
        }
        // The track and the version of the ask survive the rewrite: only the
        // spelling missed, and the entry asked for that exact pin.
        const resolved = suggestion === undefined ? entry : formatQuery({ ...query, spelling: suggestion });
        // A rewrite can land on the spelling that another entry already carries,
        // thus the answer dedupes as well as the input: `r:seurat` and
        // `r:SEURAT` are one ask once both take the spelling that the pool holds.
        if (emitted.has(resolved)) continue;
        emitted.add(resolved);
        packages.push(resolved);
    }
    return { packages, droppedPackages };
}

function routeTool() {
    return {
        submit_route: aiTool({
            description: "Submit the single specialist, the resource recommendation, and the packages of the step. This is the only valid response.",
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
    const timer = setTimeout(
        () => controller.abort(new Error("ad hoc routing timed out")),
        effectiveDeadlineMs(deps.provider, AD_HOC_ROUTER_TIMEOUT_MS, deps.timeoutMs),
    );
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let raw: unknown;
    let failure: AdHocRoute["fallbackClass"];
    try {
        const response = unwrapOrThrow(
            await deps.provider.chat(
                {
                    system: [
                        "Select exactly one specialist for a targeted one-step analysis, estimate its sandbox resources, and name the packages that the step imports.",
                        "Choose only from the supplied catalog. Do not create a plan, reject the request, or select scientific-executor.",
                        resourceEstimationSection(deps.resourcePolicy),
                        resourceBounds(deps.resourcePolicy),
                        packagesSection(),
                        "You hold no package census. For a name that both ecosystems hold, the language of the specialist you select and the wording of the request decide the track.",
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
    // The packages validate last and on their own axis: a package failure
    // never becomes a `fallbackClass`, because that class describes the route
    // as a whole and a step agent reads it as "the routing itself fell back".
    const { packages, droppedPackages } = await routePackages(candidate.packages, deps.resolvePackages, logger);
    logger.info("ad hoc route selected", { agentId, resources, rationale, failure, packages, droppedPackages });
    return { agentId, resources, rationale, packages, droppedPackages, ...(failure ? { fallbackClass: failure } : {}) };
}
