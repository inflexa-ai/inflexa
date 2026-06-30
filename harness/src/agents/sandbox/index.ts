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

import { createBulkTranscriptomicsAgent, meta as bulkTranscriptomicsMeta } from "./bulk-transcriptomics-agent.js";
import { createCheminformaticsAgent, meta as cheminformaticsMeta } from "./cheminformatics-agent.js";
import { createChromatinAgent, meta as chromatinMeta } from "./chromatin-agent.js";
import { createDataProfilerAgent, meta as dataProfilerMeta } from "./data-profiler.js";
import { createDnaMethylationAgent, meta as dnaMethylationMeta } from "./dna-methylation-agent.js";
import { createDrugRepurposingAgent, meta as drugRepurposingMeta } from "./drug-repurposing-agent.js";
import { createEnrichmentAgent, meta as enrichmentMeta } from "./enrichment-agent.js";
import { createEphemeralExecutorAgent, meta as ephemeralExecutorMeta } from "./ephemeral-executor.js";
import { createGenomicVariantAgent, meta as genomicVariantMeta } from "./genomic-variant-agent.js";
import { createImmuneProfilingAgent, meta as immuneProfilingMeta } from "./immune-profiling-agent.js";
import { createMetabolomicsAgent, meta as metabolomicsMeta } from "./metabolomics-agent.js";
import { createMicrobiomeAgent, meta as microbiomeMeta } from "./microbiome-agent.js";
import { createMultiOmicsIntegrationAgent, meta as multiOmicsIntegrationMeta } from "./multi-omics-integration-agent.js";
import { createMultimodalScAgent, meta as multimodalScMeta } from "./multimodal-sc-agent.js";
import { createNetworkAgent, meta as networkMeta } from "./network-agent.js";
import { createPkpdClinicalResponseAgent, meta as pkpdClinicalResponseMeta } from "./pkpd-clinical-response-agent.js";
import { createProteomicsAgent, meta as proteomicsMeta } from "./proteomics-agent.js";
import { createScientificExecutorAgent, meta as scientificExecutorMeta } from "./scientific-executor.js";
import { createSingleCellAgent, meta as singleCellMeta } from "./single-cell-agent.js";
import { createSpatialOmicsAgent, meta as spatialOmicsMeta } from "./spatial-omics-agent.js";
import { createStatisticalModelingAgent, meta as statisticalModelingMeta } from "./statistical-modeling-agent.js";
import { createTranslationalSafetyAgent, meta as translationalSafetyMeta } from "./translational-safety-agent.js";

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
    [bulkTranscriptomicsMeta.id]: bulkTranscriptomicsMeta,
    [singleCellMeta.id]: singleCellMeta,
    [multimodalScMeta.id]: multimodalScMeta,
    [spatialOmicsMeta.id]: spatialOmicsMeta,
    [proteomicsMeta.id]: proteomicsMeta,
    [metabolomicsMeta.id]: metabolomicsMeta,
    [genomicVariantMeta.id]: genomicVariantMeta,
    [dnaMethylationMeta.id]: dnaMethylationMeta,
    [chromatinMeta.id]: chromatinMeta,
    [microbiomeMeta.id]: microbiomeMeta,
    [enrichmentMeta.id]: enrichmentMeta,
    [networkMeta.id]: networkMeta,
    [statisticalModelingMeta.id]: statisticalModelingMeta,
    [multiOmicsIntegrationMeta.id]: multiOmicsIntegrationMeta,
    [cheminformaticsMeta.id]: cheminformaticsMeta,
    [translationalSafetyMeta.id]: translationalSafetyMeta,
    [pkpdClinicalResponseMeta.id]: pkpdClinicalResponseMeta,
    [immuneProfilingMeta.id]: immuneProfilingMeta,
    [drugRepurposingMeta.id]: drugRepurposingMeta,
    [scientificExecutorMeta.id]: scientificExecutorMeta,
    [ephemeralExecutorMeta.id]: ephemeralExecutorMeta,
};

/**
 * Build every sandbox `AgentDefinition` from the shared deps. The returned
 * record's keys are the agent ids; `runAgent` consumes each value.
 */
export function createSandboxAgents(deps: SandboxAgentDeps): Record<string, AgentDefinition> {
    return {
        [dataProfilerMeta.id]: createDataProfilerAgent(deps),
        [bulkTranscriptomicsMeta.id]: createBulkTranscriptomicsAgent(deps),
        [singleCellMeta.id]: createSingleCellAgent(deps),
        [multimodalScMeta.id]: createMultimodalScAgent(deps),
        [spatialOmicsMeta.id]: createSpatialOmicsAgent(deps),
        [proteomicsMeta.id]: createProteomicsAgent(deps),
        [metabolomicsMeta.id]: createMetabolomicsAgent(deps),
        [genomicVariantMeta.id]: createGenomicVariantAgent(deps),
        [dnaMethylationMeta.id]: createDnaMethylationAgent(deps),
        [chromatinMeta.id]: createChromatinAgent(deps),
        [microbiomeMeta.id]: createMicrobiomeAgent(deps),
        [enrichmentMeta.id]: createEnrichmentAgent(deps),
        [networkMeta.id]: createNetworkAgent(deps),
        [statisticalModelingMeta.id]: createStatisticalModelingAgent(deps),
        [multiOmicsIntegrationMeta.id]: createMultiOmicsIntegrationAgent(deps),
        [cheminformaticsMeta.id]: createCheminformaticsAgent(deps),
        [translationalSafetyMeta.id]: createTranslationalSafetyAgent(deps),
        [pkpdClinicalResponseMeta.id]: createPkpdClinicalResponseAgent(deps),
        [immuneProfilingMeta.id]: createImmuneProfilingAgent(deps),
        [drugRepurposingMeta.id]: createDrugRepurposingAgent(deps),
        [scientificExecutorMeta.id]: createScientificExecutorAgent(deps),
        [ephemeralExecutorMeta.id]: createEphemeralExecutorAgent(deps),
    };
}
