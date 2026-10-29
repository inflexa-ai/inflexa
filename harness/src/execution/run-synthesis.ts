/**
 * Run synthesizer — a single-shot agent loop driven through `runWithSalvage`:
 *
 *   - `submit_synthesis`  — checks one synthesis against the schema and the
 *                            semantic checks, and gives back the issues. It
 *                            does not end the run. The last accepted
 *                            submission is the synthesis.
 *   - `report_blocker`    — the run produced nothing synthesizable. An
 *                            accepted synthesis wins over a blocker.
 *   - the lookups         — the gene, protein, annotation, interaction,
 *                            PubMed, citation, drug-gene, and preclinical
 *                            tools (`createSynthesisLookupTools`). Each lookup
 *                            records the PMIDs of its result, and
 *                            `submit_synthesis` refuses a PMID that no lookup
 *                            of the run returned.
 *
 * Two deliverables on a happy path: `synthesis.json` written to the run dir
 * and a `data-run-synthesis` chat data part emitted via the `emit` callback
 * the dep wrapper provides (the wrapper forwards events to the parent
 * workflow's `"events"` stream).
 *
 * The dep wrapper handles failure semantics — if this function throws or
 * resolves with `{ kind: "failed" }`, the wrapper emits a synthesis-progress
 * `failed` part. We do not throw here for routine submitter rejections.
 */

import type { ScriptRuntime } from "../tools/script/run-script.js";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { writeFileWithinRoot } from "../lib/fs-helpers.js";
import { isAllDigits } from "../lib/text.js";
import { parseUnknownRecord } from "../lib/unknown-containers.js";
import { tryFs } from "../lib/fs-result.js";
import { safeParseJsonAs } from "../lib/parse-json.js";

import {
    RunSynthesisSchema,
    SynthesisDraftSchema,
    type BiologicalTheme,
    type KeyReference,
    type RunSynthesis,
    type SynthesisDraft,
    type SynthesizedFinding,
} from "../schemas/run-synthesis.js";
import { synthesisAgentPrompt } from "../prompts/synthesis-agent.js";
import { composeSystemPrompt } from "../agents/system-prompt.js";
import type { RunSynthesisPart } from "../contracts/chat-parts.js";
import type { StepSummary } from "../schemas/step-summary.js";
import { isSafeId, runDir } from "../workspace/paths.js";

import { runWithSalvage, type LoopOptions, type LoopStep } from "../loop/run-loop.js";
import { recordedInputOf } from "../loop/tool-adapter.js";
import type { ToolOutputStore } from "../loop/tool-output.js";
import type { AgentDefinition, ChatDataPart, EmitFn } from "../loop/types.js";
import type { ChatProvider } from "../providers/types.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { RunSession } from "../auth/types.js";
import { defineTool, readToolResultImages, withToolCallRecord, withToolResultImages, type Tool, type ToolError } from "../tools/define-tool.js";
import { createReadToolOutputTool } from "../tools/read-tool-output.js";
import type { ResolveWorkspaceRoot } from "../workspace/paths.js";
import { createReadScriptTools } from "../tools/script/file-tools.js";
import { createReadSurfaceTools, type ReadSurfaceDeps } from "../tools/workspace/read-surface.js";
import { blockerOf, createReportBlockerToolFor, REPORT_BLOCKER_TOOL_ID } from "../tools/sandbox/report-blocker.js";

// ── Agent identity / budgets ────────────────────────────────────────

/**
 * The synthesizer's agent identity — the `source.agentId` on its loop events
 * and the `agent_id` of the run-phase `synthesis` row `executeAnalysis` writes
 * to `cortex_step_executions`. One definition so the ledger row and the stream
 * events can never disagree about who did the work.
 */
export const SYNTHESIS_AGENT_ID = "run-synthesizer";

/**
 * Budget for the synthesizer loop: the rounds of lookups, each one a batch of
 * parallel calls, then the draft, 1–2 submit/fix cycles, and headroom.
 */
const SYNTHESIZER_MAX_ITERATIONS = 40;

// ── Types ────────────────────────────────────────────────────────────

export type ValidationIssue = {
    readonly path: string;
    readonly code: "schema" | "semantic";
    readonly message: string;
    readonly hint?: string;
};

export type SubmitSynthesisOutput = { accepted: true } | { accepted: false; issues: ValidationIssue[] };

const SubmitSynthesisOutputSchema = z.object({ accepted: z.boolean() });

const SUBMIT_SYNTHESIS_TOOL_ID = "submit_synthesis";

/** The facts that the semantic checks read. */
type InnerToolContext = {
    /** stepIds present in the input summaries — used for reference checks. */
    readonly knownStepIds: ReadonlySet<string>;
    /** Each PMID that a lookup of this run returned. The fold of the lookups fills it on the first run and on each replay. */
    readonly lookedUpPmids: ReadonlySet<string>;
};

// ── The PMIDs of the lookups ────────────────────────────────────────

/**
 * The keys under which a lookup gives back its request: `resolve_citation`
 * returns the citation that it was given, normalized. A PMID there came from
 * the model, not from a source.
 */
const ECHO_KEYS = new Set(["input", "normalized", "supplied", "query"]);

/** Each PMID that a lookup result holds under a `pmid` or `pmids` key, outside the echo of the request. */
export function pmidsIn(value: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) pmidsIn(item, found);
        return found;
    }
    const record = parseUnknownRecord(value);
    if (record === undefined) return found;
    for (const [key, child] of Object.entries(record)) {
        if (ECHO_KEYS.has(key)) continue;
        if (key === "pmid" && (typeof child === "string" || typeof child === "number")) {
            if (isAllDigits(String(child))) found.add(String(child));
        } else if (key === "pmids" && Array.isArray(child)) {
            for (const pmid of child) if (typeof pmid === "string" && isAllDigits(pmid)) found.add(pmid);
        } else {
            pmidsIn(child, found);
        }
    }
    return found;
}

const PmidRecordSchema = z.object({ pmids: z.array(z.string()) });

/**
 * A lookup whose ok result records the PMIDs that it holds. The loop folds the
 * record into `seen` after each round, on the first run and on each replay, thus
 * the check of `submit_synthesis` reads the same set in both.
 */
export function recordingPmids(tool: Tool, seen: Set<string>): Tool {
    if (tool.foldCallRecord !== undefined) throw new Error(`the lookup ${tool.id} keeps its own call record, which the PMID record would replace`);
    return {
        ...tool,
        execute: async (input, ctx) =>
            (await tool.execute(input, ctx)).map((value) => {
                const record = parseUnknownRecord(value);
                if (record === undefined) return value;
                // The parsed record is a copy without the symbol keys of the value, thus the pictures move over by hand.
                const images = readToolResultImages(value);
                const carried = images.length === 0 ? record : withToolResultImages(record, images);
                return withToolCallRecord(carried, { pmids: [...pmidsIn(record)] });
            }),
        foldCallRecord: (record) => {
            const parsed = PmidRecordSchema.safeParse(record);
            if (parsed.success) for (const pmid of parsed.data.pmids) seen.add(pmid);
        },
    };
}

// ── Validation ──────────────────────────────────────────────────────

// ── Semantic checks ─────────────────────────────────────────────────
//
// Each check takes only the fields it reads, never the whole synthesis.
// `semanticCheck` composes them — it is the one definition of "all semantic
// checks, in report order". The input schema of the tool checks the shape
// before them.

function checkFindingStepIds(findings: readonly SynthesizedFinding[], ctx: InnerToolContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const [i, f] of findings.entries()) {
        if (!ctx.knownStepIds.has(f.stepId)) {
            issues.push({
                path: `synthesis.findings[${i}].stepId`,
                code: "semantic",
                message: `stepId "${f.stepId}" is not in the input summaries`,
                hint: `Known stepIds: ${Array.from(ctx.knownStepIds).join(", ")}`,
            });
        }
    }
    return issues;
}

function checkThemeReferences(themes: readonly BiologicalTheme[], findings: readonly SynthesizedFinding[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const findingKeys = new Set(findings.map((f) => `${f.stepId}::${f.title}`));
    for (const [ti, t] of themes.entries()) {
        for (const [fi, ref] of t.findings.entries()) {
            if (!findingKeys.has(`${ref.stepId}::${ref.title}`)) {
                issues.push({
                    path: `synthesis.themes[${ti}].findings[${fi}]`,
                    code: "semantic",
                    message: `theme reference (stepId="${ref.stepId}", title="${ref.title}") ` + `does not match any entry in findings[]`,
                });
            }
        }
    }
    return issues;
}

function checkKeyReferencesCited(keyReferences: readonly KeyReference[], findings: readonly SynthesizedFinding[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const citedPmids = new Set(findings.flatMap((f) => f.references.map((r) => r.pmid)));
    for (const [i, r] of keyReferences.entries()) {
        if (!citedPmids.has(r.pmid)) {
            issues.push({
                path: `synthesis.keyReferences[${i}].pmid`,
                code: "semantic",
                message: `keyReferences pmid "${r.pmid}" does not appear in any finding.references[]`,
                hint: "Every keyReferences entry must already be cited by at least one finding.",
            });
        }
    }
    return issues;
}

function checkFindingPmidFormat(findings: readonly SynthesizedFinding[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const [fi, f] of findings.entries()) {
        for (const [ri, r] of f.references.entries()) {
            if (r.pmid.length === 0 || !isAllDigits(r.pmid)) {
                issues.push({
                    path: `synthesis.findings[${fi}].references[${ri}].pmid`,
                    code: "semantic",
                    message: `pmid "${r.pmid}" is not a valid numeric PMID`,
                });
            }
        }
    }
    return issues;
}

function checkKeyReferencePmidFormat(keyReferences: readonly KeyReference[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const [i, r] of keyReferences.entries()) {
        if (r.pmid.length === 0 || !isAllDigits(r.pmid)) {
            issues.push({
                path: `synthesis.keyReferences[${i}].pmid`,
                code: "semantic",
                message: `pmid "${r.pmid}" is not a valid numeric PMID`,
            });
        }
    }
    return issues;
}

function checkPmidsLookedUp(synthesis: SynthesisDraft, lookedUp: ReadonlySet<string>): ValidationIssue[] {
    const cited = [
        ...synthesis.findings.flatMap((f, fi) => f.references.map((r, ri) => ({ pmid: r.pmid, path: `synthesis.findings[${fi}].references[${ri}].pmid` }))),
        ...synthesis.keyReferences.map((r, i) => ({ pmid: r.pmid, path: `synthesis.keyReferences[${i}].pmid` })),
    ];
    return cited
        .filter(({ pmid }) => pmid.length > 0 && isAllDigits(pmid) && !lookedUp.has(pmid))
        .map(({ pmid, path }) => ({
            path,
            code: "semantic" as const,
            message: `pmid "${pmid}" is in no lookup result of this run`,
            hint: "Cite only a PMID that a lookup of this run returned. Look it up, or remove the reference.",
        }));
}

function semanticCheck(synthesis: SynthesisDraft, ctx: InnerToolContext): ValidationIssue[] {
    return [
        ...checkFindingStepIds(synthesis.findings, ctx),
        ...checkThemeReferences(synthesis.themes, synthesis.findings),
        ...checkKeyReferencesCited(synthesis.keyReferences, synthesis.findings),
        ...checkFindingPmidFormat(synthesis.findings),
        ...checkKeyReferencePmidFormat(synthesis.keyReferences),
        ...checkPmidsLookedUp(synthesis, ctx.lookedUpPmids),
    ];
}

// ── Inner tools ─────────────────────────────────────────────────────

function buildSubmitTool(ctx: InnerToolContext): Tool<{ synthesis: SynthesisDraft }, SubmitSynthesisOutput> {
    return defineTool({
        id: SUBMIT_SYNTHESIS_TOOL_ID,
        description:
            "Submit the synthesis. Checks the payload against the semantic checks " +
            "the arg schema cannot express (stepId refs, theme→finding refs, " +
            "keyReferences PMIDs cited, numeric PMIDs, each PMID returned by a lookup of this run). On success returns " +
            "{accepted: true} — STOP after this. On rejection returns " +
            "{accepted: false, issues} — fix the specific fields at each issue " +
            "path and call again, or switch to report_blocker if the synthesis " +
            "cannot be made valid. The last accepted submission is the synthesis.",
        inputSchema: z.object({ synthesis: SynthesisDraftSchema }),
        describeCall: "none",
        execute: (input): Promise<Result<SubmitSynthesisOutput, ToolError>> => {
            const issues = semanticCheck(input.synthesis, ctx);
            return Promise.resolve(ok(issues.length > 0 ? { accepted: false as const, issues } : { accepted: true as const }));
        },
    });
}

/** The last accepted synthesis of a run, from the inputs of the calls of `submit_synthesis` that it accepted. */
export function acceptedSynthesisOf(steps: readonly LoopStep[]): SynthesisDraft | undefined {
    let accepted: SynthesisDraft | undefined;
    for (const step of steps) {
        for (const call of step.calls) {
            if (call.toolName !== SUBMIT_SYNTHESIS_TOOL_ID || call.output?.outcome !== "ok") continue;
            const outcome = SubmitSynthesisOutputSchema.safeParse(call.output.value);
            const input = recordedInputOf(z.object({ synthesis: SynthesisDraftSchema }), call.input);
            if (outcome.success && outcome.data.accepted && input !== undefined) accepted = input.synthesis;
        }
    }
    return accepted;
}

function buildBlockerTool(): Tool<{ reason: string }> {
    return createReportBlockerToolFor({
        blockedWhen:
            "Ends run synthesis with no synthesis written. Use it ONLY when the " +
            "run produced no synthesizable content — every step summary is empty, " +
            "or the summaries are contradictory to the point of incoherence. A run " +
            "with non-empty summaries but no individually notable findings is NOT a " +
            "blocker: submit a synthesis with an empty findings[] instead. Never " +
            "use it as an escape from a synthesis you could fix and submit.",
    });
}

/**
 * Test-only — expose the inner-tool factory so unit tests can assert on
 * the checks without driving the whole agent loop.
 */
export function __buildInnerToolsForTest(args: { knownStepIds: ReadonlySet<string>; lookedUpPmids?: ReadonlySet<string> }): {
    submit: Tool<{ synthesis: SynthesisDraft }, SubmitSynthesisOutput>;
    blocker: Tool<{ reason: string }>;
} {
    const ctx: InnerToolContext = { knownStepIds: args.knownStepIds, lookedUpPmids: args.lookedUpPmids ?? new Set() };
    return { submit: buildSubmitTool(ctx), blocker: buildBlockerTool() };
}

// ── Public API ──────────────────────────────────────────────────────

export type GenerateRunSynthesisInput = {
    readonly provider: ChatProvider;
    readonly session: RunSession;
    readonly model: string;
    /** The lookup tools of the synthesizer (`createSynthesisLookupTools`). They run in `run_script`. */
    readonly synthesisLookups: readonly Tool[];
    /** Where the VM of `run_script` comes from. See {@link ScriptRuntime}. */
    readonly scriptRuntime?: ScriptRuntime;
    /** LLM usage-accounting seam for the synthesizer loop; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** The store of the synthesizer loop and of its read tool. */
    readonly toolOutputStore?: ToolOutputStore;
    /** The read-only surface of the workspace. The synthesizer reads a file of the run where a summary is thin. */
    readonly workspace: SynthesizerWorkspace;
    /** Step summaries from the completed run. Non-empty. */
    readonly summaries: readonly StepSummary[];
    /** Plan analytical narrative for context. */
    readonly planNarrative: string;
    /** Run id — the host stamps it on the accepted synthesis. */
    readonly runId: string;
    /** Optional cancellation. */
    readonly signal?: AbortSignal;
    /** Optional UI event sink (chat data parts forwarded to the parent stream). */
    readonly emit?: EmitFn;
    /** The pause of the run. The body of the run gives it, thus a failed request waits in place. */
    readonly pause?: LoopOptions["pause"];
};

/** The read-only workspace of the synthesizer: the file tools, the search, the data profile, and the script reads. */
export type SynthesizerWorkspace = ReadSurfaceDeps & { readonly resolveWorkspaceRoot: ResolveWorkspaceRoot };

/** What the synthesizer agent is built from, for a consumer that runs the agent outside `generateRunSynthesis`. */
export type SynthesizerAgentInput = Pick<
    GenerateRunSynthesisInput,
    "model" | "synthesisLookups" | "scriptRuntime" | "toolOutputStore" | "summaries" | "workspace"
>;

/** The synthesizer agent of one run. Its submit tool checks the step ids of the summaries and the PMIDs of its lookups. */
export function synthesizerAgentOf(input: SynthesizerAgentInput): AgentDefinition {
    const knownStepIds = new Set(input.summaries.map((s) => s.stepId));
    const lookedUpPmids = new Set<string>();
    const innerCtx: InnerToolContext = { knownStepIds, lookedUpPmids };

    const readTools = input.toolOutputStore ? [createReadToolOutputTool(input.toolOutputStore)] : [];
    // The lookups run in `run_script`, which gives the PMID record of each nested call to its lookup.
    return {
        id: SYNTHESIS_AGENT_ID,
        systemPrompt: composeSystemPrompt(synthesisAgentPrompt),
        model: input.model,
        tools: [...createReadSurfaceTools(input.workspace), buildSubmitTool(innerCtx), buildBlockerTool(), ...readTools],
        scriptTools: [...input.synthesisLookups.map((tool) => recordingPmids(tool, lookedUpPmids)), ...createReadScriptTools(input.workspace)],
        scriptRuntime: input.scriptRuntime,
        maxIterations: SYNTHESIZER_MAX_ITERATIONS,
    };
}

export type GenerateRunSynthesisResult = { kind: "synthesis"; synthesis: RunSynthesis } | { kind: "skipped"; reason: string };

/**
 * Drive the synthesizer agent loop to an outcome — the last accepted
 * synthesis (`submit_synthesis`), else a blocker (`report_blocker`).
 * Throws when the run and its salvage end with neither (loop cap or external abort).
 */
export async function generateRunSynthesis(input: GenerateRunSynthesisInput): Promise<GenerateRunSynthesisResult> {
    if (input.summaries.length === 0) {
        throw new Error("Run synthesis: no step summaries to synthesize");
    }

    const agent = synthesizerAgentOf(input);
    const prompt = synthesizerSeedOf(input.planNarrative, input.summaries);

    const signal = input.signal ?? new AbortController().signal;
    const emit: EmitFn = input.emit ?? (() => {});

    const run = await runWithSalvage(
        agent,
        [{ role: "user", content: prompt }],
        input.session,
        {
            provider: input.provider,
            signal,
            emit,
            usageRecorder: input.usageRecorder,
            toolOutputStore: input.toolOutputStore,
            pause: input.pause,
        },
        {
            tools: [SUBMIT_SYNTHESIS_TOOL_ID, REPORT_BLOCKER_TOOL_ID],
            nudge:
                "You ended without an accepted synthesis. You MUST call " +
                "submit_synthesis with the final synthesis now, or report_blocker " +
                "if the run produced nothing synthesizable. Do not reply with prose.",
            hasOutcome: (steps) => acceptedSynthesisOf(steps) !== undefined || blockerOf(steps) !== null,
        },
    );

    const accepted = acceptedSynthesisOf(run.steps);
    if (accepted !== undefined) {
        // The model never types the run id: the host stamps the id of its own run.
        return { kind: "synthesis", synthesis: { runId: input.runId, ...accepted } };
    }
    const blocker = blockerOf(run.steps);
    if (blocker !== null) {
        return { kind: "skipped", reason: blocker.reason };
    }
    if (signal.aborted) {
        throw new Error("Run synthesis was cancelled.");
    }
    throw new Error("Run synthesis completed without a terminal tool call — the synthesizer " + "did not call submit_synthesis or report_blocker.");
}

// ── Disk I/O — load summaries + persist synthesis ───────────────────

export type LoadStepSummariesInput = {
    /** Absolute host root of the analysis's workspace tree. */
    readonly workspaceRoot: string;
    readonly runId: string;
    readonly completedSteps: readonly string[];
    readonly agentByStepId?: Readonly<Record<string, string>>;
};

/**
 * Read each completed step's `output/summary.md`. Steps with missing or empty
 * summaries are silently dropped — the caller decides what to do when the
 * resulting array is empty.
 */
export async function loadStepSummariesFromDisk(args: LoadStepSummariesInput): Promise<StepSummary[]> {
    const out: StepSummary[] = [];
    for (const stepId of args.completedSteps) {
        const path = join(args.workspaceRoot, "runs", args.runId, stepId, "output", "summary.md");
        try {
            const markdown = await readFile(path, "utf8");
            if (markdown.trim().length === 0) continue;
            out.push({
                stepId,
                agentId: args.agentByStepId?.[stepId] ?? "scientific-executor",
                markdown,
            });
        } catch {
            // Missing summary — skip silently. Steps that produced no summary do
            // not contribute to synthesis.
        }
    }
    return out;
}

/** The file name of the synthesis record inside the run directory. */
const SYNTHESIS_FILE = "synthesis.json";

/**
 * The cap of one synthesis read. A synthesis record is small by construction, and the cap bounds the
 * cost of a file that is not. A file over the cap gives no text, because a cut JSON text cannot parse.
 */
const SYNTHESIS_CAP_BYTES = 1024 * 1024;

export type PersistSynthesisInput = {
    /** Absolute host root of the analysis's workspace tree. */
    readonly workspaceRoot: string;
    readonly runId: string;
    readonly synthesis: RunSynthesis;
};

export async function persistSynthesis(args: PersistSynthesisInput): Promise<string> {
    // Confine to the run directory, not the whole workspace: synthesis.json sits
    // at runs/{runId}/, above any step's RW mount and never in the hard-linked
    // `data/` inputs.
    const runRoot = join(args.workspaceRoot, runDir(args.runId));
    const path = join(runRoot, SYNTHESIS_FILE);
    await writeFileWithinRoot(runRoot, path, JSON.stringify(args.synthesis, null, 2));
    return path;
}

export type ReadSynthesisInput = {
    /** Absolute host root of the analysis's workspace tree. */
    readonly workspaceRoot: string;
    readonly runId: string;
};

/**
 * Read the text of a synthesis record under the cap, or give `undefined` when the bytes do not come back.
 *
 * The read takes a bounded byte window, thus a file of any size costs the cap. A run id that can escape
 * the run tree, an absent file, a genuine read fault, and a file over the cap each give `undefined`,
 * because a collection reports no error for one record.
 */
export async function readSynthesisText(args: ReadSynthesisInput): Promise<string | undefined> {
    // The path builder refuses an id that can escape the run tree with a throw. The guard keeps the read on
    // the value channel.
    if (!isSafeId(args.runId)) {
        return undefined;
    }
    const absolute = join(args.workspaceRoot, runDir(args.runId), SYNTHESIS_FILE);
    return tryFs<string | undefined>(
        "runSynthesis.readText",
        async () => {
            const handle = await open(absolute, "r");
            try {
                // The window takes one byte more than the cap. A read that fills it states that the file
                // holds more bytes than the cap admits, thus the two conditions stay apart.
                const buffer = Buffer.alloc(SYNTHESIS_CAP_BYTES + 1);
                // One read of a network-backed file can give fewer bytes than the window holds. Such a
                // short read cuts the text in the middle of the JSON, and the record then parses to no
                // key at all. Thus the loop reads again from the offset that the last read reached, and
                // it stops when the window fills or when a read gives no byte.
                let filled = 0;
                while (filled < buffer.length) {
                    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
                    if (bytesRead === 0) {
                        break;
                    }
                    filled += bytesRead;
                }
                return filled > SYNTHESIS_CAP_BYTES ? undefined : buffer.subarray(0, filled).toString("utf8");
            } finally {
                await handle.close();
            }
        },
        { path: absolute, onAbsent: () => undefined },
    ).unwrapOr(undefined);
}

/**
 * The validated synthesis record of a run as the flat `data-run-synthesis` part, the shape that the run
 * stream carries for the same record. It gives `null` for each fault of {@link readSynthesisText}, for text
 * that is not JSON, and for JSON that fails {@link RunSynthesisSchema}. The run row stays the authority on
 * whether a synthesis exists, thus the read does not consult it.
 */
export async function readRunSynthesis(args: ReadSynthesisInput): Promise<RunSynthesisPart | null> {
    const text = await readSynthesisText(args);
    if (text === undefined) {
        return null;
    }
    let parsed;
    try {
        parsed = safeParseJsonAs(text, RunSynthesisSchema);
    } catch {
        return null;
    }
    if (!parsed.success) {
        return null;
    }
    return { type: "data-run-synthesis", ...runSynthesisPartFields(args.runId, parsed.data) };
}

// ── Embedding text ──────────────────────────────────────────────────

export function formatSynthesisEmbeddingText(synthesis: RunSynthesis): string {
    return [
        "# Overview",
        synthesis.overview,
        "",
        "# Conclusions",
        synthesis.conclusions,
        "",
        "# Key Findings",
        ...synthesis.findings.flatMap((f) => [
            `## ${f.title} [${f.noveltyStatus}]`,
            f.description,
            f.literatureInterpretation,
            ...(f.references.length > 0 ? f.references.map((r) => `- [PMID:${r.pmid}] ${r.citation} (${r.concordance})`) : []),
            "",
        ]),
        "# Themes",
        ...synthesis.themes.flatMap((t) => [`## ${t.name}`, t.narrative, ""]),
        "# Limitations",
        ...synthesis.limitations.map((l) => `- ${l}`),
        "",
        "# Key References",
        ...synthesis.keyReferences.map((r) => `- [PMID:${r.pmid}] ${r.citation} — ${r.description}`),
    ].join("\n");
}

// ── Prompt builder ──────────────────────────────────────────────────

/** The first message of the synthesizer: the narrative of the plan and the summary of each step. */
export function synthesizerSeedOf(planNarrative: string, summaries: readonly StepSummary[]): string {
    const summaryBlock = summaries.map((s) => `### ${s.stepId} (${s.agentId})\n\n${s.markdown}`).join("\n\n---\n\n");

    return ["## Analytical Narrative", planNarrative, "", "## Step Summaries", summaryBlock].join("\n");
}

// ── Chat data part builders ─────────────────────────────────────────

/**
 * Build the `data-run-synthesis` chat part the parent stream emits when the
 * synthesizer completes successfully. The schema mirrors the harness's contracts
 * `RunSynthesisPart` interface — keep them in lockstep.
 */
export function buildRunSynthesisPart(runId: string, synthesis: RunSynthesis): ChatDataPart {
    return { type: "data-run-synthesis", data: runSynthesisPartFields(runId, synthesis) };
}

/** The flat fields of the `data-run-synthesis` part, shared by the stream part and the stored-record read. */
function runSynthesisPartFields(runId: string, synthesis: RunSynthesis): Omit<RunSynthesisPart, "type"> {
    return {
        id: `synthesis-${runId}`,
        runId,
        overview: synthesis.overview,
        conclusions: synthesis.conclusions,
        findings: synthesis.findings,
        themes: synthesis.themes,
        limitations: synthesis.limitations,
        keyReferences: synthesis.keyReferences,
    };
}
