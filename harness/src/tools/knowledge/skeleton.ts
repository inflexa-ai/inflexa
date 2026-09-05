/**
 * The plan skeleton: the procedure of the service folded into the steps of a
 * plan, with the agent, the packages, the dependencies, the constraints, and
 * the grounding of each step filled from the answer. A small model edits a
 * skeleton where it fails to compose a plan from a procedure; a frontier
 * model pays nothing for it. The skeleton carries only the fields the
 * answer can fill. The question, the acceptance criteria, the resources, and
 * the step budget come from the data profile, and the planner adds them.
 *
 * The fold is fixed: one QC step, one differential expression step that
 * holds the filter, the normalization, the design, the test, the shrinkage,
 * and the multiple testing (the templates cover the same span), one
 * enrichment step on its own track, and one report step. A group with no
 * step in the procedure is absent from the skeleton.
 */

import type { RecommendWithEnvironment } from "./environment.js";

export interface SkeletonStep {
    readonly id: string;
    readonly name: string;
    readonly track: string;
    readonly step_type: string;
    readonly agent: string;
    readonly packages: readonly string[];
    readonly depends_on: readonly string[];
    readonly constraints: readonly string[];
    readonly caveats: readonly string[];
    readonly grounding: {
        readonly status: "grounded" | "ungrounded" | "flagged";
        readonly snapshot: string;
        readonly claims: readonly string[];
        readonly template?: string;
        readonly reason: string;
    };
}

type ProcedureStep = RecommendWithEnvironment["procedure"][number];

const GROUPS: readonly {
    readonly id: string;
    readonly track: string;
    readonly step_type: string;
    readonly agent: string;
    readonly steps: readonly string[];
    readonly name: string;
}[] = [
    { id: "T1S1", track: "T1", step_type: "qc", agent: "bulk-transcriptomics-agent", steps: ["qc_sample_structure"], name: "Sample structure QC" },
    {
        id: "T1S2",
        track: "T1",
        step_type: "analysis",
        agent: "bulk-transcriptomics-agent",
        steps: ["filter_low_counts", "normalize", "model_design", "differential_expression", "shrink_lfc", "multiple_testing"],
        name: "Differential expression",
    },
    { id: "T2S1", track: "T2", step_type: "enrichment", agent: "enrichment-agent", steps: ["enrichment"], name: "Gene set enrichment" },
    { id: "T1S3", track: "T1", step_type: "report", agent: "bulk-transcriptomics-agent", steps: ["report"], name: "Report" },
];

const DEPENDS: Readonly<Record<string, readonly string[]>> = { T1S1: [], T1S2: ["T1S1"], T2S1: ["T1S2"], T1S3: ["T1S2", "T2S1"] };

function renderValue(value: unknown): string {
    return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

export function buildPlanSkeleton(answer: RecommendWithEnvironment): SkeletonStep[] {
    const byStep = new Map<string, ProcedureStep>(answer.procedure.map((step) => [step.step, step]));
    const present = new Set(answer.procedure.map((step) => step.step));
    const kept = GROUPS.filter((group) => group.steps.some((step) => present.has(step)));
    const keptIds = new Set(kept.map((group) => group.id));
    return kept.map((group) => {
        const steps = group.steps.map((step) => byStep.get(step)).filter((step): step is ProcedureStep => step !== undefined);
        const central = steps.find((step) => step.step === "differential_expression") ?? steps.find((step) => step.method !== undefined) ?? steps[0];
        const flags = steps.flatMap((step) => step.flags ?? []);
        const hardFlag = flags.find((flag) => flag.severity === "flag");
        const claims = [...new Set(steps.flatMap((step) => step.rules))];
        const packages = [
            ...new Set(steps.map((step) => (step as { package?: { name: string } }).package?.name).filter((name): name is string => name !== undefined)),
        ];
        const constraints = steps.flatMap((step) =>
            (step.parameters ?? []).map(
                (parameter) =>
                    `${step.step}: ${parameter.name} = ${renderValue(parameter.value)}${parameter.default_source ? ` (${parameter.default_source})` : ""}`,
            ),
        );
        const caveats = flags.filter((flag) => flag.severity === "warn").map((flag) => flag.message);
        const method = central?.method;
        const status = hardFlag ? "flagged" : method ? "grounded" : "ungrounded";
        const name = method && group.id !== "T1S1" && group.id !== "T1S3" ? method.label : group.name;
        return {
            id: group.id,
            name,
            track: group.track,
            step_type: group.step_type,
            agent: group.agent,
            packages,
            depends_on: DEPENDS[group.id]!.filter((id) => keptIds.has(id)),
            constraints,
            caveats: hardFlag ? [hardFlag.message, ...caveats] : caveats,
            grounding: {
                status,
                snapshot: answer.snapshot.digest,
                claims,
                ...(central?.template ? { template: central.template } : {}),
                reason: hardFlag ? `flagged by ${hardFlag.rule}` : method ? `${method.label} per ${claims[0] ?? "the procedure"}` : "no rule covers this step",
            },
        };
    });
}
