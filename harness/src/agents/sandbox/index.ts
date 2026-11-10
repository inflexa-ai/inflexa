/**
 * Sandbox agent catalog + composition root.
 *
 * `createSandboxAgents(deps)` returns one `AgentDefinition` per sandbox
 * agent — the harness loop's substrate. `SANDBOX_AGENT_META` exposes the
 * meta record the planner-facing catalog (`harness/agents/sandbox-catalog.ts`)
 * derives from.
 *
 * Adding a new sandbox agent: add the per-agent file under
 * `harness/agents/sandbox/`, import its `meta` + `create*` factory below,
 * and add one entry to each of the two arrays. Both wire-ups type-check
 * against `SandboxToolName`, so any inconsistency surfaces at compile time.
 */

import type { AgentDefinition } from "../../loop/types.js";

import { type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

import { createAnalystAgent, meta as analystMeta } from "./analyst.js";
import { createDataProfilerAgent, meta as dataProfilerMeta } from "./data-profiler.js";
import { createDrugAnalystAgent, meta as drugAnalystMeta } from "./drug-analyst.js";

export { BASE_SANDBOX_TOOLS, createSandboxAgent } from "./shared.js";
export type { SandboxAgentDeps, SandboxStepCoords } from "./shared.js";
export type { AgentMeta, SandboxToolName } from "./types.js";
export { SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS } from "./types.js";

/**
 * Per-agent meta — id, planner-facing description, tool allowlist. The
 * source of truth that `harness/agents/sandbox-catalog.ts`'s planner
 * catalog derives from.
 */
export const SANDBOX_AGENT_META: Readonly<Record<string, AgentMeta>> = {
    [dataProfilerMeta.id]: dataProfilerMeta,
    [analystMeta.id]: analystMeta,
    [drugAnalystMeta.id]: drugAnalystMeta,
};

/**
 * Build every sandbox `AgentDefinition` from the shared deps. The returned
 * record's keys are the agent ids; `runLoop` consumes each value.
 */
export function createSandboxAgents(deps: SandboxAgentDeps): Record<string, AgentDefinition> {
    return {
        [dataProfilerMeta.id]: createDataProfilerAgent(deps),
        [analystMeta.id]: createAnalystAgent(deps),
        [drugAnalystMeta.id]: createDrugAnalystAgent(deps),
    };
}
