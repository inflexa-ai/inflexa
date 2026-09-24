import { describe, expect, it } from "bun:test";

import { DATA_PROFILE_ORIENTATION_MAX_CHARS } from "../app/data-profile-orientation.js";
import type { DataProfileResult } from "../state/data-profile.js";
import { AnalysisStepSchema } from "../schemas/workflow-state.js";
import type { AnalysisStep } from "../schemas/workflow-state.js";
import { WORKING_MEMORY_LIMITS } from "../memory/working-memory.js";
import {
    ANALYSIS_MEMORY_HEADING,
    MAX_UPSTREAM_ARTIFACTS,
    MAX_UPSTREAM_DEPS,
    STEP_NON_TASK_FIELDS,
    STEP_TASK_FIELDS,
    UPSTREAM_SUMMARY_MAX_CHARS,
    composeStepBriefing,
    emptyStepMemory,
    renderMemory,
    renderOrientation,
    renderTask,
    renderUpstream,
    type StepMemory,
    type UpstreamHandoff,
} from "./briefing.js";

/** A step whose every task field carries a unique, greppable sentinel. */
function fullyPopulatedStep(): AnalysisStep {
    return {
        id: "T1S1",
        name: "SENTINEL_NAME",
        track: "T1",
        step_type: "analysis",
        question: "SENTINEL_QUESTION",
        description: "SENTINEL_DESCRIPTION",
        context: "SENTINEL_CONTEXT",
        constraints: ["SENTINEL_CONSTRAINT_A", "SENTINEL_CONSTRAINT_B"],
        acceptance_criteria: ["SENTINEL_ACCEPTANCE"],
        caveats: ["SENTINEL_CAVEAT"],
        depends_on: [],
        status: "pending",
        resources: { cpu: 1, memoryGb: 2 },
        agent: "bulk-transcriptomics-agent",
        maxSteps: 10,
    };
}

function handoff(overrides: Partial<UpstreamHandoff> = {}): UpstreamHandoff {
    return {
        stepId: "T1S1",
        agentId: "bulk-transcriptomics-agent",
        summaryMarkdown: "UPSTREAM_GIST",
        summaryPath: "/an-1/runs/run-1/T1S1/output/summary.md",
        outputDir: "/an-1/runs/run-1/T1S1/output",
        artifacts: ["/an-1/runs/run-1/T1S1/output/de.csv"],
        ...overrides,
    };
}

const MEMORY: StepMemory = {
    goal: "SENTINEL_GOAL",
    constraints: [
        { id: "c1", text: "SENTINEL_USER_RULE", origin: "user" },
        { id: "c2", text: "SENTINEL_AGENT_RULE", origin: "agent" },
    ],
};

const WORKSPACE = {
    analysisId: "an-1",
    workingDir: "/an-1/runs/run-1/T1S2",
} as const;

// ── renderTask ───────────────────────────────────────────────────────

describe("renderTask", () => {
    it("includes the content of every task-bearing field", () => {
        const prompt = renderTask(fullyPopulatedStep());
        // Behavioural, not formatting-coupled: we assert the field VALUES survive
        // the render, not the exact headings or layout around them.
        for (const sentinel of [
            "SENTINEL_NAME",
            "SENTINEL_QUESTION",
            "SENTINEL_DESCRIPTION",
            "SENTINEL_CONTEXT",
            "SENTINEL_CONSTRAINT_A",
            "SENTINEL_CONSTRAINT_B",
            "SENTINEL_ACCEPTANCE",
            "SENTINEL_CAVEAT",
        ]) {
            expect(prompt).toContain(sentinel);
        }
    });

    it("renders a sparse step (question only) without empty sections", () => {
        const prompt = renderTask({
            ...fullyPopulatedStep(),
            description: undefined,
            context: undefined,
            constraints: undefined,
            caveats: undefined,
            // acceptance_criteria is required by the schema; keep one.
            acceptance_criteria: ["SENTINEL_ACCEPTANCE"],
        });
        expect(prompt).toContain("SENTINEL_QUESTION");
        // No heading should be emitted with an empty body.
        expect(prompt).not.toMatch(/##[^\n]*\n\s*(\n|$)/);
    });

    it("does not silently drop multi-element array fields", () => {
        const prompt = renderTask({
            ...fullyPopulatedStep(),
            constraints: ["C1", "C2", "C3", "C4"],
            acceptance_criteria: ["AC1", "AC2"],
        });
        for (const v of ["C1", "C2", "C3", "C4", "AC1", "AC2"]) {
            expect(prompt).toContain(v);
        }
    });
});

// ── renderOrientation ────────────────────────────────────────────────

describe("renderOrientation", () => {
    const profile: DataProfileResult = {
        summary: "bulk RNA-seq of tumour vs normal",
        files: [{ path: "data/inputs/counts.csv", description: "raw counts", format: "CSV", rows: 20000, cols: 24 }],
        profiledAt: "2026-01-01T00:00:00.000Z",
        domain: "transcriptomics",
        subtype: "bulk-rna-seq",
        organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "inferred", confidence: "high" },
    };

    it("carries the dataset identity when a profile exists", () => {
        const rendered = renderOrientation(profile, "an-1");
        expect(rendered).toContain("transcriptomics");
        expect(rendered).toContain("Homo sapiens");
        expect(rendered).toContain("/an-1/data/inputs/counts.csv");
    });

    it("omits the section cleanly when the analysis has no profile yet", () => {
        expect(renderOrientation(null, "an-1")).toBe("");
        expect(renderOrientation(undefined, "an-1")).toBe("");
    });

    it("bounds a pathological profile to the orientation budget", () => {
        const huge: DataProfileResult = {
            ...profile,
            experimentalDesign: "x".repeat(10_000),
            qualityAssessment: { concerns: Array.from({ length: 40 }, (_, i) => `concern ${i} ${"y".repeat(500)}`) },
            files: Array.from({ length: 200 }, (_, i) => ({
                path: `data/inputs/f${i}.csv`,
                description: "z".repeat(1_000),
            })),
        };
        // The projection is hard-clamped; the section adds only its heading and
        // the fixed pointer at the pull-the-full-profile tool.
        expect(renderOrientation(huge, "an-1").length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS + 200);
    });
});

// ── renderUpstream ───────────────────────────────────────────────────

describe("renderUpstream", () => {
    it("renders one block per completed dependency with its id, agent, gist, and paths", () => {
        const rendered = renderUpstream([handoff()]);
        expect(rendered).toContain("T1S1");
        expect(rendered).toContain("bulk-transcriptomics-agent");
        expect(rendered).toContain("UPSTREAM_GIST");
        expect(rendered).toContain("/an-1/runs/run-1/T1S1/output/summary.md");
        expect(rendered).toContain("/an-1/runs/run-1/T1S1/output");
        expect(rendered).toContain("/an-1/runs/run-1/T1S1/output/de.csv");
    });

    it("renders nothing for a step with no completed dependencies", () => {
        expect(renderUpstream([])).toBe("");
    });

    it("clamps each dependency's summary to the excerpt budget and points at the full document", () => {
        const rendered = renderUpstream([handoff({ summaryMarkdown: "M".repeat(5_000) })]);
        const excerptLength = (rendered.match(/M+…?/)?.[0] ?? "").length;
        expect(excerptLength).toBeLessThanOrEqual(UPSTREAM_SUMMARY_MAX_CHARS);
        expect(rendered).toContain("/an-1/runs/run-1/T1S1/output/summary.md");
    });

    it("renders at most MAX_UPSTREAM_DEPS dependencies and counts the rest", () => {
        const many = Array.from({ length: MAX_UPSTREAM_DEPS + 3 }, (_, i) => handoff({ stepId: `T1S${i}`, summaryMarkdown: `GIST_${i}` }));
        const rendered = renderUpstream(many);
        for (let i = 0; i < MAX_UPSTREAM_DEPS; i++) expect(rendered).toContain(`GIST_${i}`);
        expect(rendered).not.toContain(`GIST_${MAX_UPSTREAM_DEPS}`);
        expect(rendered).toContain("+3 more");
    });

    it("lists at most MAX_UPSTREAM_ARTIFACTS artifacts per dependency and counts the rest", () => {
        const artifacts = Array.from({ length: MAX_UPSTREAM_ARTIFACTS + 4 }, (_, i) => `/an-1/runs/run-1/T1S1/output/f${i}.csv`);
        const rendered = renderUpstream([handoff({ artifacts })]);
        expect(rendered).toContain("/an-1/runs/run-1/T1S1/output/f0.csv");
        expect(rendered).not.toContain(`/an-1/runs/run-1/T1S1/output/f${MAX_UPSTREAM_ARTIFACTS}.csv`);
        expect(rendered).toContain("+4 more");
    });

    it("still renders a dependency's paths when its summary is empty", () => {
        const rendered = renderUpstream([handoff({ summaryMarkdown: "" })]);
        expect(rendered).toContain("T1S1");
        expect(rendered).toContain("/an-1/runs/run-1/T1S1/output");
    });
});

// ── renderMemory ─────────────────────────────────────────────────────

describe("renderMemory", () => {
    it("renders the goal and each constraint with its origin under its own heading", () => {
        const rendered = renderMemory(MEMORY);
        expect(rendered.startsWith(`## ${ANALYSIS_MEMORY_HEADING}\n`)).toBe(true);
        expect(rendered).toContain("Goal: SENTINEL_GOAL");
        expect(rendered).toContain("- (user) SENTINEL_USER_RULE");
        expect(rendered).toContain("- (agent) SENTINEL_AGENT_RULE");
        expect(rendered).toContain("A constraint from the user is binding. A constraint from the agent is context.");
    });

    it("does not print the entry ids, because the step agent cannot address an entry", () => {
        expect(renderMemory(MEMORY)).not.toContain("[c1]");
    });

    it("renders nothing for a memory with no goal and no constraints", () => {
        expect(renderMemory(emptyStepMemory())).toBe("");
        expect(renderMemory({ goal: "   ", constraints: [{ id: "c1", text: " ", origin: "user" }] })).toBe("");
    });

    it("renders a goal alone, and constraints alone", () => {
        const goalOnly = renderMemory({ goal: "ONLY_GOAL", constraints: [] });
        expect(goalOnly).toContain("Goal: ONLY_GOAL");
        expect(goalOnly).not.toContain("Constraints:");

        const constraintsOnly = renderMemory({ goal: "", constraints: MEMORY.constraints });
        expect(constraintsOnly).not.toContain("Goal:");
        expect(constraintsOnly).toContain("SENTINEL_USER_RULE");
    });

    it("bounds an over-cap row to the newest constraints and clamps each text", () => {
        const count = WORKING_MEMORY_LIMITS.constraints + 3;
        const constraints = Array.from({ length: count }, (_, i) => ({ id: `c${i}`, text: `RULE_${i}_`, origin: "user" as const }));
        const rendered = renderMemory({ goal: "G".repeat(WORKING_MEMORY_LIMITS.goalChars * 2), constraints });

        expect(rendered).not.toContain("RULE_0_");
        expect(rendered).not.toContain("RULE_2_");
        expect(rendered).toContain("RULE_3_");
        expect(rendered).toContain(`RULE_${count - 1}_`);
        expect(rendered).toContain("(+3 older constraints not shown)");
        expect(rendered).not.toContain("G".repeat(WORKING_MEMORY_LIMITS.goalChars + 1));

        const long = renderMemory({ goal: "", constraints: [{ id: "c1", text: "L".repeat(WORKING_MEMORY_LIMITS.entryChars * 2), origin: "agent" }] });
        expect(long).not.toContain("L".repeat(WORKING_MEMORY_LIMITS.entryChars + 1));
        expect(long).toContain("…");
    });
});

// ── composeStepBriefing ──────────────────────────────────────────────

describe("composeStepBriefing", () => {
    const profile: DataProfileResult = {
        summary: "bulk RNA-seq",
        files: [],
        profiledAt: "2026-01-01T00:00:00.000Z",
        domain: "transcriptomics",
    };

    it("carries the completed dependency's id, summary excerpt, and output dir into a downstream step's seed", () => {
        const seed = composeStepBriefing({
            step: fullyPopulatedStep(),
            workspace: WORKSPACE,
            profile: null,
            upstream: [handoff()],
            memory: emptyStepMemory(),
        });
        expect(seed).toContain("T1S1");
        expect(seed).toContain("UPSTREAM_GIST");
        expect(seed).toContain("/an-1/runs/run-1/T1S1/output");
    });

    it("gives an independent step no upstream section at all", () => {
        const seed = composeStepBriefing({
            step: fullyPopulatedStep(),
            workspace: WORKSPACE,
            profile: null,
            upstream: [],
            memory: emptyStepMemory(),
        });
        expect(seed).toContain("SENTINEL_QUESTION");
        expect(seed).not.toContain("Upstream results");
        // Sections collapse out — no blank heading, no double-blank gap.
        expect(seed).not.toMatch(/\n{3,}/);
    });

    it("includes the data orientation when a profile exists and omits it cleanly when it does not", () => {
        const withProfile = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile, upstream: [], memory: emptyStepMemory() });
        const without = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile: null, upstream: [], memory: emptyStepMemory() });
        expect(withProfile).toContain("transcriptomics");
        expect(without).not.toContain("Data orientation");
        expect(without).not.toMatch(/\n{3,}/);
    });

    it("names the step's writable working directory and the read-only analysis root", () => {
        const seed = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile: null, upstream: [], memory: emptyStepMemory() });
        expect(seed).toContain("/an-1/runs/run-1/T1S2");
        expect(seed).toContain("/an-1");
    });

    it("renders the resource budget and the workers-times-threads rule", () => {
        const seed = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile: null, upstream: [], memory: emptyStepMemory() });
        expect(seed).toContain("Resources (hard limits)");
        expect(seed).toContain("workers × threads-per-worker");
    });

    it("omits the resources section for a historical step that carries none", () => {
        const step = { ...fullyPopulatedStep(), resources: undefined };
        const seed = composeStepBriefing({ step, workspace: WORKSPACE, profile: null, upstream: [], memory: emptyStepMemory() });
        expect(seed).not.toContain("Resources (hard limits)");
        expect(seed).not.toMatch(/\n{3,}/);
    });

    it("carries the analysis memory apart from the constraints of the plan step", () => {
        const seed = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile: null, upstream: [], memory: MEMORY });
        expect(seed).toContain(`## ${ANALYSIS_MEMORY_HEADING}`);
        expect(seed).toContain("SENTINEL_USER_RULE");
        // The step's own constraints stay in the task section, under their own heading.
        expect(seed).toContain("## Constraints (each one is a requirement of this step)");
        expect(seed.indexOf("SENTINEL_CONSTRAINT_A")).toBeLessThan(seed.indexOf(ANALYSIS_MEMORY_HEADING));
        expect(seed).not.toContain("Hypotheses");
        expect(seed).not.toContain("Findings");
    });

    it("omits the analysis-memory section cleanly when the memory is empty", () => {
        const seed = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile: null, upstream: [], memory: emptyStepMemory() });
        expect(seed).not.toContain(ANALYSIS_MEMORY_HEADING);
        expect(seed).not.toMatch(/\n{3,}/);
    });

    it("is byte-identical when recomposed from the same data (replay stability)", () => {
        const briefing = {
            step: fullyPopulatedStep(),
            workspace: WORKSPACE,
            profile,
            upstream: [handoff(), handoff({ stepId: "T1S9", summaryMarkdown: "OTHER" })],
            memory: MEMORY,
        };
        expect(composeStepBriefing(briefing)).toBe(composeStepBriefing(briefing));
    });
});

// ── AnalysisStep field-coverage guard ────────────────────────────────

describe("AnalysisStep field-coverage guard", () => {
    // The point of this suite: when someone ADDS a field to AnalysisStepSchema,
    // one of these tests fails until they make a deliberate decision about
    // whether the sandbox agent needs to see it. It does not assert layout, so
    // wording/format changes to the renderer never break it.

    const schemaKeys = Object.keys(AnalysisStepSchema.shape) as (keyof AnalysisStep)[];

    it("classifies every schema field as task or non-task", () => {
        const task = new Set<string>(STEP_TASK_FIELDS);
        const nonTask = new Set<string>(STEP_NON_TASK_FIELDS);

        const unclassified = schemaKeys.filter((k) => !task.has(k) && !nonTask.has(k));
        expect(
            unclassified,
            `New AnalysisStep field(s) ${JSON.stringify(unclassified)} are not classified. ` +
                "Add each to STEP_TASK_FIELDS (and render it in renderTask) or to " +
                "STEP_NON_TASK_FIELDS, depending on whether the sandbox agent needs to see it.",
        ).toEqual([]);
    });

    it("keeps the analysis memory out of the plan step, because it comes from the working memory at dispatch", () => {
        expect(schemaKeys as string[]).not.toContain("memory");
    });

    it("never classifies a field as both task and non-task", () => {
        const overlap = STEP_TASK_FIELDS.filter((f) => (STEP_NON_TASK_FIELDS as readonly string[]).includes(f));
        expect(overlap).toEqual([]);
    });

    it("does not reference fields that no longer exist on the schema", () => {
        const all = [...STEP_TASK_FIELDS, ...STEP_NON_TASK_FIELDS];
        const stale = all.filter((f) => !schemaKeys.includes(f));
        expect(stale, `Field(s) ${JSON.stringify(stale)} are listed in briefing.ts ` + "but no longer exist on AnalysisStepSchema.").toEqual([]);
    });

    it("actually renders every field declared as task-bearing", () => {
        // Build a step with a unique sentinel per task field, driven off the
        // declared field list so a newly-declared task field that the renderer
        // forgets to emit is caught here.
        const base = fullyPopulatedStep();
        const sentinels = new Map<string, string>();
        const step = { ...base } as Record<string, unknown>;
        for (const field of STEP_TASK_FIELDS) {
            const sentinel = `COVER_${field.toUpperCase()}`;
            sentinels.set(field, sentinel);
            const current = (base as Record<string, unknown>)[field];
            step[field] = Array.isArray(current) ? [sentinel] : sentinel;
        }
        const prompt = renderTask(step as unknown as AnalysisStep);
        for (const [field, sentinel] of sentinels) {
            expect(prompt, `task field "${field}" is not rendered`).toContain(sentinel);
        }
    });
});
