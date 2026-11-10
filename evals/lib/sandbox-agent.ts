/**
 * `--sandbox-agent`: a sandbox case runs with a different step agent. The case keeps its id, thus
 * `compare` pairs the two reports case by case.
 */

import { okAsync } from "neverthrow";

import { SANDBOX_AGENT_META } from "@inflexa-ai/harness/agents/sandbox/index.js";
import type { EvalCase } from "./case.js";
import { openSandboxTrial, PROFILER_ID, type SandboxSetup } from "./sandbox.js";

/** A case under the override, and the scripts of the tools that the new agent does not hold. */
export type OverriddenCase = { readonly evalCase: EvalCase; readonly dropped: readonly string[] };

/** The step agent of an override. */
type Replacement = Pick<SandboxSetup, "agentId">;

/** The ids of the agents that can replace a step agent. The profiler runs a different task, thus it is not one. */
export function overrideAgentIds(): string[] {
    return Object.keys(SANDBOX_AGENT_META).filter((id) => id !== PROFILER_ID);
}

/**
 * The case with `replacement` as its step agent. `toolIds` are the ids of each tool and script tool of that agent, and
 * a script for any other tool is dropped. A case of the profiler, or a case that is not a sandbox case, does not change.
 */
export function withSandboxAgent(evalCase: EvalCase, replacement: Replacement, toolIds: ReadonlySet<string>): OverriddenCase {
    if (evalCase.sandbox === undefined || evalCase.sandbox.agentId === PROFILER_ID) return { evalCase, dropped: [] };
    const scripts = Object.entries(evalCase.tools ?? {});
    const dropped = scripts.filter(([id]) => !toolIds.has(id)).map(([id]) => id);
    return {
        evalCase: {
            ...evalCase,
            sandbox: { ...evalCase.sandbox, ...replacement },
            tools: Object.fromEntries(scripts.filter(([id]) => toolIds.has(id))),
        },
        dropped,
    };
}

/** The tool ids of `replacement` over the setup of a case. The setup decides some tools, for example `knowledge_template`. */
async function toolIdsOf(evalCase: EvalCase, replacement: Replacement): Promise<Set<string>> {
    if (evalCase.sandbox === undefined) return new Set();
    const trial = await openSandboxTrial(
        { ...evalCase.sandbox, ...replacement },
        { toolOutputStore: { put: () => okAsync(undefined), get: () => okAsync(null) }, label: "override" },
    );
    await trial.dispose();
    return new Set([...trial.agent.tools, ...(trial.agent.scriptTools ?? [])].map((tool) => tool.id));
}

async function override(cases: readonly EvalCase[], replacementOf: (agentId: string) => Replacement): Promise<OverriddenCase[]> {
    const out: OverriddenCase[] = [];
    for (const evalCase of cases) {
        if (evalCase.sandbox === undefined || evalCase.sandbox.agentId === PROFILER_ID) {
            out.push({ evalCase, dropped: [] });
            continue;
        }
        const replacement = replacementOf(evalCase.sandbox.agentId);
        out.push(withSandboxAgent(evalCase, replacement, await toolIdsOf(evalCase, replacement)));
    }
    return out;
}

/** Each case with `agentId` as its step agent. */
export function overrideSandboxAgent(cases: readonly EvalCase[], agentId: string): Promise<OverriddenCase[]> {
    return override(cases, () => ({ agentId }));
}
