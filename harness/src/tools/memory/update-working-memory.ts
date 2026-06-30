/**
 * update-working-memory — the agent's single interface for maintaining
 * working memory.
 *
 * Dependency-bearing: the `WorkingMemoryStore` is captured by the factory
 * (see the harness-durable-runtime spec). The analysis id is read from the request-scoped `Session`.
 *
 * The input is a flat object with a `section` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (Anthropic needs a
 * top-level `"type":"object"`). The variant fields are validated by
 * `.refine` so a malformed call (e.g. a `finding` with no `runId`) fails
 * at the loop boundary and surfaces as an `is_error` tool result.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import type { ConstraintOp, ListOp, WorkingMemoryStore } from "../../memory/working-memory.js";
import { scopeResource } from "../../auth/types.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { defineTool } from "../define-tool.js";

const inputSchema = z
    .object({
        section: z.enum(["goal", "constraint", "hypothesis", "finding"]).describe("Which working-memory section to update."),
        operation: z
            .enum(["add", "revise", "retire"])
            .optional()
            .describe(
                "For constraint/hypothesis: add a new entry (default), revise an " + "existing entry's text, or retire a stale one. Ignored for goal/finding.",
            ),
        text: z
            .string()
            .optional()
            .describe("Entry text. Required for goal, finding, and constraint/hypothesis " + "add/revise. Omit when retiring."),
        id: z
            .string()
            .optional()
            .describe("The entry id to revise or retire. Required when operation is " + "'revise' or 'retire' — copy it from the rendered working memory."),
        origin: z
            .enum(["user", "agent"])
            .optional()
            .describe("For a new constraint: whether the user stated the rule or you " + "derived it. Defaults to 'agent'."),
        runId: z.string().optional().describe("The run that produced the finding. Required when section is 'finding'."),
    })
    .refine((d) => d.section !== "goal" || d.text !== undefined, {
        message: "text is required when section is 'goal'",
        path: ["text"],
    })
    .refine((d) => d.section !== "finding" || (d.runId !== undefined && d.runId.length > 0), {
        message: "runId is required when section is 'finding'",
        path: ["runId"],
    })
    .refine((d) => d.section !== "finding" || (d.text !== undefined && d.text.length > 0), {
        message: "text is required when section is 'finding'",
        path: ["text"],
    })
    .refine((d) => !(d.operation === "revise" || d.operation === "retire") || (d.id !== undefined && d.id.length > 0), {
        message: "id is required when operation is 'revise' or 'retire'",
        path: ["id"],
    })
    .refine(
        (d) => {
            const isList = d.section === "constraint" || d.section === "hypothesis";
            const op = d.operation ?? "add";
            return !(isList && op !== "retire") || (d.text !== undefined && d.text.length > 0);
        },
        {
            message: "text is required to add or revise a constraint/hypothesis",
            path: ["text"],
        },
    );

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

export function createUpdateWorkingMemoryTool(workingMemory: WorkingMemoryStore) {
    return defineTool({
        id: "update_working_memory",
        description:
            "Maintain the analysis's working memory — its durable interpretive " +
            "layer that survives token-window eviction. Section-addressable: set " +
            "the 'goal', add/revise/retire a 'constraint' (a binding rule) or a " +
            "'hypothesis', or record a 'finding' under a runId. Updates one " +
            "section at a time; the others are untouched.",
        inputSchema,
        execute: async (input, ctx) => {
            const analysisId = scopeResource(ctx.session.scope).resourceId;
            switch (input.section) {
                case "goal":
                    unwrapOrThrow(
                        await workingMemory.updateSection(analysisId, "goal", {
                            text: input.text!,
                        }),
                    );
                    break;
                case "constraint":
                    unwrapOrThrow(await workingMemory.updateSection(analysisId, "constraint", toConstraintOp(input)));
                    break;
                case "hypothesis":
                    unwrapOrThrow(await workingMemory.updateSection(analysisId, "hypothesis", toListOp(input)));
                    break;
                case "finding":
                    unwrapOrThrow(
                        await workingMemory.updateSection(analysisId, "finding", {
                            runId: input.runId!,
                            text: input.text!,
                        }),
                    );
                    break;
            }
            return ok({ ok: true, section: input.section });
        },
    });
}
