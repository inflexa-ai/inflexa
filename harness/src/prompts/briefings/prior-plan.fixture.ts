/**
 * Colocated input fixture for the prior-plan briefing snapshot test — a
 * representative `{ planId, plan }` with an analytical narrative and a small
 * multi-step DAG. Deterministic, so the briefing renders identically each run.
 */

import type { PriorPlanInput } from "./prior-plan.js";

export const priorPlanFixture: PriorPlanInput = {
    planId: "pln-1a2b3c4d",
    plan: {
        title: "AD lesional vs control DE + pathways",
        analytical_narrative: "Contrast lesional against control skin to surface differentially expressed genes, then map them to enriched pathways.",
        created_at: "2026-07-09T10:00:00.000Z",
        omicsType: "transcriptomics",
        omicsSubtype: "bulk-rna-seq",
        steps: [
            {
                id: "T1S1",
                name: "Differential expression",
                track: "T1",
                step_type: "analysis",
                question: "Which genes are differentially expressed between AD_lesional and Control?",
                acceptance_criteria: ["A ranked DE table with log2FC and adjusted p-values."],
                depends_on: [],
                status: "pending",
                maxSteps: 12,
                agent: "bulk-transcriptomics-agent",
            },
            {
                id: "T1S2",
                name: "Pathway enrichment",
                track: "T1",
                step_type: "analysis",
                question: "Which pathways are enriched among the significant DE genes?",
                acceptance_criteria: ["An enrichment table with pathway ids and adjusted p-values."],
                depends_on: ["T1S1"],
                status: "pending",
                maxSteps: 10,
                agent: "enrichment-agent",
            },
        ],
    },
};
