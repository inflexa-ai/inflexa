import { describe, expect, it } from "bun:test";

import { DATA_PROFILE_ORIENTATION_MAX_CHARS } from "../app/data-profile-orientation.js";
import type { DataProfileResult } from "../state/data-profile.js";
import { AnalysisStepSchema } from "../schemas/workflow-state.js";
import type { AnalysisStep } from "../schemas/workflow-state.js";
import { contractAnswer } from "../tools/knowledge/__fixtures__/fake-client.js";
import {
    MAX_TEMPLATE_SLOTS,
    MAX_UPSTREAM_ARTIFACTS,
    MAX_UPSTREAM_DEPS,
    STEP_NON_TASK_FIELDS,
    STEP_TASK_FIELDS,
    TEMPLATE_SLOT_DESCRIPTION_MAX_CHARS,
    UPSTREAM_SUMMARY_MAX_CHARS,
    composeStepBriefing,
    renderOrientation,
    renderTask,
    renderTemplateContract,
    renderUpstream,
    type TemplateBrief,
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
        grounding: {
            status: "grounded",
            snapshot: "sha256:SENTINEL_SNAPSHOT",
            claims: ["SENTINEL_CLAIM"],
            template: "tpl-sentinel@1.0.0",
            settings: [{ step: "differential_expression", name: "lfc_shrink", value: "apeglm", source: "doi:10.1093/bioinformatics/bty895" }],
            reason: "SENTINEL_REASON",
        },
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

const WORKSPACE = {
    analysisId: "an-1",
    workingDir: "/an-1/runs/run-1/T1S2",
} as const;

/**
 * The brief of the fake contract as the parent composes it: every parameter of
 * the contract (the pinned `alpha` included, thus the renderer's own filter is
 * what the tests prove), the inputs, one bound setting, and one unbound line.
 */
function brief(overrides: Partial<TemplateBrief> = {}): TemplateBrief {
    const contract = contractAnswer();
    return {
        ref: "tpl-deseq2-two-group@1.0.0",
        version_served: contract.version,
        slots: contract.parameters,
        inputs: contract.inputs ?? [],
        bound: [{ name: "lfc_shrink", value: "apeglm", source: "doi:10.1093/bioinformatics/bty895" }],
        unbound_settings: ["`alpha` = 0.05 (differential_expression): pinned by the template at the same value"],
        ...overrides,
    };
}

/** The names of the adaptable slots of the fake contract. */
const ADAPTABLE_SLOTS = contractAnswer()
    .parameters.filter((slot) => slot.adaptable)
    .map((slot) => slot.name);

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

// ── renderTemplateContract ───────────────────────────────────────────

describe("renderTemplateContract", () => {
    it("renders every adaptable slot by name and never the pinned one", () => {
        const rendered = renderTemplateContract(brief());
        expect(ADAPTABLE_SLOTS.length).toBeGreaterThan(0);
        for (const name of ADAPTABLE_SLOTS) expect(rendered).toContain(`- \`${name}\` (`);
        expect(rendered).not.toContain("- `alpha` (");
    });

    it("renders the permitted values, the pattern, the sourced default, and the required state", () => {
        const rendered = renderTemplateContract(brief({ bound: [], unbound_settings: [] }));
        // The enum of lfc_shrink, as JSON values.
        expect(rendered).toContain('Permitted: "apeglm", "ashr", "none".');
        // The pattern of the design slot.
        expect(rendered).toContain("Pattern: `condition\\s*$`.");
        // A default with its source.
        expect(rendered).toContain("`min_count` (integer; default 10 [doi:10.12688/f1000research.7035.1]; min 0)");
        // A required slot without a default, and an optional one.
        expect(rendered).toContain("`counts_path` (string; required)");
        expect(rendered).toContain("`min_samples` (integer; optional; min 1)");
    });

    it("renders the inputs with the slot path that gives each", () => {
        const rendered = renderTemplateContract(brief());
        expect(rendered).toContain("counts: `{{counts_path}}` — Gene by sample integer counts, CSV.");
        expect(rendered).toContain("metadata: `{{metadata_path}}`");
    });

    it("renders each bound setting with its value and source, under the override rule", () => {
        const rendered = renderTemplateContract(brief());
        expect(rendered).toContain("Bound by the plan");
        expect(rendered).toContain('`lfc_shrink` = "apeglm" (doi:10.1093/bioinformatics/bty895)');
        expect(rendered).toContain("`overrides`");
    });

    it("names the unbound settings", () => {
        const rendered = renderTemplateContract(brief());
        expect(rendered).toContain("Unbound settings");
        expect(rendered).toContain("`alpha` = 0.05 (differential_expression): pinned by the template at the same value");
    });

    it("collapses the bound and unbound lists when they are empty", () => {
        const rendered = renderTemplateContract(brief({ bound: [], unbound_settings: [] }));
        expect(rendered).not.toContain("Bound by the plan");
        expect(rendered).not.toContain("Unbound settings");
        expect(rendered).not.toMatch(/\n{3,}/);
    });

    it("renders nothing when no contract was retrieved", () => {
        expect(renderTemplateContract(undefined)).toBe("");
    });

    it("states a served version that differs from the plan as a caveat", () => {
        const rendered = renderTemplateContract(brief({ version_served: "1.1.0", bound: [] }));
        expect(rendered).toContain("the plan names version 1.0.0, and the service serves version 1.1.0");
        expect(rendered).toContain("not bound");
    });

    it("renders no version caveat when the reference names no version", () => {
        const rendered = renderTemplateContract(brief({ ref: "tpl-deseq2-two-group" }));
        expect(rendered).not.toContain("Caveat");
    });

    it("bounds the slot count and clamps each description", () => {
        const wide = Array.from({ length: MAX_TEMPLATE_SLOTS + 16 }, (_, i) => ({
            name: `slot_${i}`,
            type: "string",
            description: `D${i}_${"x".repeat(2_000)}`,
            adaptable: true,
        }));
        const rendered = renderTemplateContract(brief({ slots: wide, inputs: [], bound: [], unbound_settings: [] }));
        for (let i = 0; i < MAX_TEMPLATE_SLOTS; i++) expect(rendered).toContain(`\`slot_${i}\``);
        expect(rendered).not.toContain(`\`slot_${MAX_TEMPLATE_SLOTS}\``);
        expect(rendered).toContain("+16 more");
        const longestRun = Math.max(...(rendered.match(/x+/g) ?? [""]).map((run) => run.length));
        expect(longestRun).toBeLessThan(TEMPLATE_SLOT_DESCRIPTION_MAX_CHARS);
        expect(rendered.length).toBeLessThan(MAX_TEMPLATE_SLOTS * (TEMPLATE_SLOT_DESCRIPTION_MAX_CHARS + 80) + 600);
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
        });
        expect(seed).toContain("SENTINEL_QUESTION");
        expect(seed).not.toContain("Upstream results");
        // Sections collapse out — no blank heading, no double-blank gap.
        expect(seed).not.toMatch(/\n{3,}/);
    });

    it("includes the data orientation when a profile exists and omits it cleanly when it does not", () => {
        const withProfile = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile, upstream: [] });
        const without = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile: null, upstream: [] });
        expect(withProfile).toContain("transcriptomics");
        expect(without).not.toContain("Data orientation");
        expect(without).not.toMatch(/\n{3,}/);
    });

    it("names the step's writable working directory and the read-only analysis root", () => {
        const seed = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile: null, upstream: [] });
        expect(seed).toContain("/an-1/runs/run-1/T1S2");
        expect(seed).toContain("/an-1");
    });

    it("renders the resource budget and the workers-times-threads rule", () => {
        const seed = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile: null, upstream: [] });
        expect(seed).toContain("Resources (hard limits)");
        expect(seed).toContain("workers × threads-per-worker");
    });

    it("omits the resources section for a historical step that carries none", () => {
        const step = { ...fullyPopulatedStep(), resources: undefined };
        const seed = composeStepBriefing({ step, workspace: WORKSPACE, profile: null, upstream: [] });
        expect(seed).not.toContain("Resources (hard limits)");
        expect(seed).not.toMatch(/\n{3,}/);
    });

    it("is byte-identical when recomposed from the same data (replay stability)", () => {
        const briefing = {
            step: fullyPopulatedStep(),
            workspace: WORKSPACE,
            profile,
            upstream: [handoff(), handoff({ stepId: "T1S9", summaryMarkdown: "OTHER" })],
            template: brief(),
        };
        expect(composeStepBriefing(briefing)).toBe(composeStepBriefing(briefing));
    });

    it("carries the template contract of a grounded step: every adaptable slot with its permitted values, and not the pinned alpha", () => {
        const seed = composeStepBriefing({ step: fullyPopulatedStep(), workspace: WORKSPACE, profile: null, upstream: [], template: brief() });
        expect(seed).toContain("## Template contract");
        for (const name of ADAPTABLE_SLOTS) expect(seed).toContain(`- \`${name}\` (`);
        expect(seed).toContain('"apeglm", "ashr", "none"');
        expect(seed).not.toContain("- `alpha` (");
        expect(seed).not.toContain("not retrieved");
        // The section sits between the task and the workspace, and no gap opens.
        expect(seed.indexOf("## Template contract")).toBeGreaterThan(seed.indexOf("## Grounding"));
        expect(seed.indexOf("## Template contract")).toBeLessThan(seed.indexOf("## Workspace"));
        expect(seed).not.toMatch(/\n{3,}/);
    });

    it("says the contract was not retrieved, with the reason, when the grounding names a template and the seed carries none", () => {
        const seed = composeStepBriefing({
            step: fullyPopulatedStep(),
            workspace: WORKSPACE,
            profile: null,
            upstream: [],
            templateNotRetrieved: "the knowledge service did not answer: timeout",
        });
        expect(seed).toContain("- Template contract: not retrieved (the knowledge service did not answer: timeout)");
        expect(seed).not.toContain("## Template contract");
        expect(seed).not.toMatch(/\n{3,}/);
    });

    it("says nothing about a contract for a step whose grounding names no template", () => {
        const step = fullyPopulatedStep();
        const ungrounded = { ...step, grounding: { ...step.grounding!, template: undefined } };
        const seed = composeStepBriefing({ step: ungrounded, workspace: WORKSPACE, profile: null, upstream: [] });
        expect(seed).not.toContain("Template contract");
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
            // An object-valued field (the grounding) keeps its shape, and each of its
            // string members carries the sentinel, thus the renderer must emit the
            // members and not only the presence of the field. A list of objects
            // (the settings) keeps one object whose string members carry it.
            const withSentinel = (value: unknown): unknown => {
                if (Array.isArray(value)) {
                    const first: unknown = value[0];
                    return typeof first === "object" && first !== null ? [withSentinel(first)] : [sentinel];
                }
                if (typeof value === "object" && value !== null) {
                    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, withSentinel(member)]));
                }
                return typeof value === "string" ? sentinel : value;
            };
            step[field] = withSentinel(current);
        }
        const prompt = renderTask(step as unknown as AnalysisStep);
        for (const [field, sentinel] of sentinels) {
            expect(prompt, `task field "${field}" is not rendered`).toContain(sentinel);
        }
    });
});
