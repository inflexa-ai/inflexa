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
    {
        id: "T2S2",
        track: "T2",
        step_type: "activity",
        agent: "enrichment-agent",
        steps: ["tf_activity", "pathway_activity"],
        name: "Regulator and pathway activity",
    },
    { id: "T1S4", track: "T1", step_type: "analysis", agent: "bulk-transcriptomics-agent", steps: ["variance_partition"], name: "Variance partition" },
    { id: "T3S1", track: "T3", step_type: "analysis", agent: "bulk-transcriptomics-agent", steps: ["signature_scoring"], name: "Signature scoring" },
    { id: "T3S2", track: "T3", step_type: "analysis", agent: "bulk-transcriptomics-agent", steps: ["deconvolution"], name: "Cell type deconvolution" },
    { id: "T3S3", track: "T3", step_type: "analysis", agent: "bulk-transcriptomics-agent", steps: ["coexpression"], name: "Co-expression modules" },
    { id: "T3S4", track: "T3", step_type: "analysis", agent: "bulk-transcriptomics-agent", steps: ["clustering"], name: "Sample clustering" },
    { id: "T3S5", track: "T3", step_type: "analysis", agent: "bulk-transcriptomics-agent", steps: ["survival"], name: "Outcome association" },
    { id: "T1S5", track: "T1", step_type: "analysis", agent: "bulk-transcriptomics-agent", steps: ["transcript_level"], name: "Transcript-level analysis" },
    { id: "T1S6", track: "T1", step_type: "analysis", agent: "bulk-transcriptomics-agent", steps: ["annotation"], name: "Identifier annotation" },
    { id: "T1S3", track: "T1", step_type: "report", agent: "bulk-transcriptomics-agent", steps: ["report"], name: "Report" },
];

/**
 * The dependencies of each group. A group depends on the QC, on the
 * differential expression when its input is a results table, and the report
 * depends on every group that is present.
 */
const DEPENDS: Readonly<Record<string, readonly string[]>> = {
    T1S1: [],
    T1S2: ["T1S1"],
    T2S1: ["T1S2"],
    T2S2: ["T1S2", "T1S1"],
    T1S4: ["T1S1"],
    T3S1: ["T1S1"],
    T3S2: ["T1S1"],
    T3S3: ["T1S1"],
    T3S4: ["T1S1"],
    T3S5: ["T3S1", "T1S1"],
    T1S5: ["T1S1"],
    T1S6: ["T1S1"],
    T1S3: ["T1S2", "T2S1", "T2S2", "T1S4", "T3S1", "T3S2", "T3S3", "T3S4", "T3S5", "T1S5", "T1S6"],
};

function renderValue(value: unknown): string {
    return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

/** `a and b`, or `a, b and c` for a longer list. */
function joinWithAnd(items: readonly string[]): string {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The caveats a step carries beside its warn flags. A parameter conflict, a
 * substitution, and a language limit each render as a caveat, never as a
 * constraint: a constraint is copied into the plan as a value, and none of
 * the three is a value.
 */
function stepCaveats(step: ProcedureStep): string[] {
    const caveats: string[] = [];
    for (const conflict of step.conflicts ?? []) {
        caveats.push(`${step.step}: ${conflict.parameter} conflicts between ${joinWithAnd(conflict.entries.map((entry) => entry.rule))}`);
    }
    if (step.substitution && step.method) {
        caveats.push(`${step.method.label} stands in for ${step.substitution.label}`);
    }
    if (step.limit) {
        // Only two languages exist, thus the named template is in the other one.
        const named = step.limit.requested_language === "python" ? "R" : "Python";
        caveats.push(`the requested language has no template that realizes ${step.method?.label ?? step.step} for this design; the ${named} template is named`);
    }
    return caveats;
}

/** The present dependencies of a group; a group whose own dependency is absent falls back to the QC. */
function dependsOn(id: string, kept: ReadonlySet<string>): string[] {
    const present = (DEPENDS[id] ?? []).filter((dependency) => kept.has(dependency));
    if (present.length > 0) return [...new Set(present)];
    return id !== "T1S1" && kept.has("T1S1") ? ["T1S1"] : [];
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
        const caveats = [...flags.filter((flag) => flag.severity === "warn").map((flag) => flag.message), ...steps.flatMap(stepCaveats)];
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
            depends_on: dependsOn(group.id, keptIds),
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
