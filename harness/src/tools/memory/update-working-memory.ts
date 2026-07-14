/**
 * update-working-memory — the agent's single interface for maintaining
 * working memory.
 *
 * Dependency-bearing: the `WorkingMemoryStore` and the database `Pool` are
 * captured by the factory (see the harness-durable-runtime spec). The analysis
 * id is read from the request-scoped `Session`.
 *
 * The input is a flat object with a `section` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (Anthropic needs a
 * top-level `"type":"object"`). The variant fields are validated by
 * `.refine` so a malformed call (e.g. a `finding` with no `runId`) fails
 * at the loop boundary and surfaces as an `is_error` tool result.
 *
 * Working memory is re-injected in full on every turn, so it is bounded at the
 * write. The text caps are declared in the input schema — a violation is a
 * validation error the model sees before `execute` runs — and the entry-count
 * caps are enforced by the store under its row lock. Neither ever truncates: an
 * over-cap write is refused with a message telling the model to shorten the
 * text or retire a stale entry first.
 *
 * A finding cites the run that produced it, so adding one verifies the run
 * exists AND belongs to this analysis (`cortex_runs.analysis_id`) before it is
 * stored: an unknown runId is an `err(ToolError)` the model can correct from,
 * not a silent reference to a run that never existed.
 */

import { err, ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import type { ConstraintOp, FindingOp, ListOp, Section, SectionValue, WorkingMemoryStore } from "../../memory/working-memory.js";
import { scopeResource } from "../../auth/types.js";
import { toThrowable, unwrapOrThrow } from "../../lib/result.js";
import { isWorkingMemoryRejection, WORKING_MEMORY_LIMITS } from "../../memory/working-memory.js";
import { queryRun } from "../../state/index.js";
import { defineTool, type ToolError } from "../define-tool.js";

const { goalChars, entryChars, constraints, hypotheses, findings } = WORKING_MEMORY_LIMITS;

const inputSchema = z
    .object({
        section: z.enum(["goal", "constraint", "hypothesis", "finding"]).describe("Which working-memory section to update."),
        operation: z
            .enum(["add", "revise", "retire"])
            .optional()
            .describe(
                "For constraint/hypothesis/finding: add a new entry (default), revise an " +
                    "existing entry's text, or retire one that no longer earns its place. " +
                    "Ignored for goal — a goal write always replaces the previous goal.",
            ),
        text: z
            .string()
            .min(1)
            .max(goalChars, `text is over the ${goalChars}-character cap — nothing was recorded; shorten it and retry.`)
            .optional()
            .describe(
                `Entry text. Required for goal, and for add/revise on any section; omit when retiring. ` +
                    `Max ${entryChars} characters for a constraint/hypothesis/finding, ${goalChars} for the goal. ` +
                    `Over the cap is REJECTED, never truncated — write one concise line and leave the detail ` +
                    `in the run, which inspect_run still serves.`,
            ),
        id: z
            .string()
            .optional()
            .describe("The entry id to revise or retire. Required when operation is " + "'revise' or 'retire' — copy it from the rendered working memory."),
        origin: z
            .enum(["user", "agent"])
            .optional()
            .describe("For a new constraint: whether the user stated the rule or you " + "derived it. Defaults to 'agent'."),
        runId: z
            .string()
            .optional()
            .describe(
                "The run that produced the finding. Required when ADDING a finding (revise " +
                    "and retire address the finding by its own id instead). Must be an existing " +
                    "run of this analysis — copy it verbatim from inspect_run. A runId that does " +
                    "not exist is rejected; never invent one.",
            ),
    })
    .refine((d) => d.section !== "goal" || (d.text !== undefined && d.text.trim().length > 0), {
        message: "text is required when section is 'goal'",
        path: ["text"],
    })
    .refine((d) => d.section !== "finding" || (d.operation ?? "add") !== "add" || (d.runId !== undefined && d.runId.length > 0), {
        message: "runId is required when adding a finding — copy an existing runId from inspect_run",
        path: ["runId"],
    })
    .refine((d) => !(d.operation === "revise" || d.operation === "retire") || (d.id !== undefined && d.id.length > 0), {
        message: "id is required when operation is 'revise' or 'retire'",
        path: ["id"],
    })
    .refine((d) => d.section === "goal" || (d.operation ?? "add") === "retire" || (d.text !== undefined && d.text.trim().length > 0), {
        message: "text is required to add or revise a constraint/hypothesis/finding",
        path: ["text"],
    })
    .refine((d) => d.section === "goal" || d.text === undefined || d.text.trim().length <= entryChars, {
        message:
            `a constraint/hypothesis/finding is capped at ${entryChars} characters (only the goal may reach ` +
            `${goalChars}). Nothing was recorded — rewrite it as one concise line and retry.`,
        path: ["text"],
    });

type Input = z.infer<typeof inputSchema>;

/** Map a validated flat input to a constraint/hypothesis list amendment. */
function toListOp(input: Input): ListOp {
    switch (input.operation ?? "add") {
        case "add":
            return { op: "add", text: input.text! };
        case "revise":
            return { op: "revise", id: input.id!, text: input.text! };
        case "retire":
            return { op: "retire", id: input.id! };
    }
}

function toConstraintOp(input: Input): ConstraintOp {
    const base = toListOp(input);
    return base.op === "add" ? { ...base, origin: input.origin ?? "agent" } : base;
}

/** As `toListOp`, but an added finding also carries the run it is attributed to. */
function toFindingOp(input: Input): FindingOp {
    const base = toListOp(input);
    return base.op === "add" ? { ...base, runId: input.runId! } : base;
}

interface UpdateOutput {
    readonly ok: true;
    readonly section: Input["section"];
}

export function createUpdateWorkingMemoryTool(workingMemory: WorkingMemoryStore, pool: Pool) {
    /** Write one amendment, mapping a refused write to a model-visible error. */
    async function apply<S extends Section>(analysisId: string, section: S, value: SectionValue[S]): Promise<Result<UpdateOutput, ToolError>> {
        const written = await workingMemory.updateSection(analysisId, section, value);
        if (written.isErr()) {
            // A refused write (cap hit, unknown id) is an expected outcome the model
            // can act on — its message carries the remedy. A DbError is not: it throws,
            // and the loop's dispatch catch maps it to a generic error tool result.
            if (isWorkingMemoryRejection(written.error)) {
                return err({ error: written.error.message, retryable: true });
            }
            throw toThrowable(written.error);
        }
        return ok({ ok: true, section });
    }

    return defineTool({
        id: "update_working_memory",
        description:
            "Maintain the analysis's working memory — the durable interpretive layer that survives " +
            "context-window eviction. It is re-injected IN FULL on every turn, so every entry is re-read " +
            "for the life of the analysis: promote only what must outlive the window, and retire what no " +
            "longer earns its place.\n\n" +
            "Sections (one per call; the other three are left untouched):\n" +
            `- goal — the analysis's current objective as you understand it. A write replaces it. Max ${goalChars} chars.\n` +
            `- constraint — a binding rule the rest of the analysis must obey. origin 'user' (the user ` +
            `stated it: "use FDR 0.01") or 'agent' (you derived it: "the data is paired, so every test must ` +
            `be paired"). Max ${constraints} entries.\n` +
            `- hypothesis — a hypothesis under active exploration. Retire it once it is resolved or ` +
            `abandoned. Max ${hypotheses} entries.\n` +
            `- finding — a durable conclusion, cited to the run that produced it (runId, copied verbatim ` +
            `from inspect_run). Record the conclusion, never the run's contents — the run itself stays ` +
            `retrievable with inspect_run. Max ${findings} entries across all runs.\n\n` +
            "Operations (constraint / hypothesis / finding): 'add' (default), 'revise' (id + new text), " +
            "'retire' (id). Copy the id from the [id] shown against each entry in the rendered working memory.\n\n" +
            `Caps are enforced, never truncated: text over the cap (${entryChars} chars; ${goalChars} for the goal), or an ` +
            "add into a full section, is REJECTED and nothing is stored. Shorten the text, or retire a stale " +
            "entry before adding the new one.\n\n" +
            "PROMOTE: a binding rule the user states or you derive; a durable conclusion a run produced; a " +
            "shift in the analysis's objective; a hypothesis you are actively testing.\n" +
            'DO NOT PROMOTE: transient conversational asks ("show me the top genes"), restatements of the ' +
            "user's last message, run contents (tables, gene lists, file paths), or anything you can retrieve " +
            "again with inspect_run, read_file, or search.",
        inputSchema,
        execute: async (input, ctx): Promise<Result<UpdateOutput, ToolError>> => {
            const analysisId = scopeResource(ctx.session.scope).resourceId;
            switch (input.section) {
                case "goal":
                    return apply(analysisId, "goal", { text: input.text! });
                case "constraint":
                    return apply(analysisId, "constraint", toConstraintOp(input));
                case "hypothesis":
                    return apply(analysisId, "hypothesis", toListOp(input));
                case "finding": {
                    const op = toFindingOp(input);
                    if (op.op === "add") {
                        // A run of another analysis is as wrong as one that does not exist —
                        // both are "no such run here", so they share one message.
                        const run = unwrapOrThrow(await queryRun(pool, op.runId));
                        if (!run || run.analysisId !== analysisId) {
                            return err({
                                error:
                                    `unknown runId "${op.runId}" — this analysis has no such run, so the ` +
                                    `finding was NOT recorded. Call inspect_run with no arguments to list ` +
                                    `this analysis's runs, copy an exact runId from that list, and retry. ` +
                                    `Do not guess a runId.`,
                                retryable: true,
                            });
                        }
                    }
                    return apply(analysisId, "finding", op);
                }
            }
        },
    });
}
