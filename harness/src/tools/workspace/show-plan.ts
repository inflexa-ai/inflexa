/**
 * showPlan tool — references a stored plan by id.
 *
 * Validates that the plan exists and is scoped to the current analysis,
 * then emits a `data-plan` event with the full plan content embedded so the
 * UI can render it without a follow-up fetch.
 *
 * Dependency-bearing: the database `Pool` is captured by the factory
 * (see the harness-durable-runtime spec). The analysis id is read from the request-scoped `Session`.
 */

import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { buildPlanCardData } from "../../memory/card-builders.js";
import { scopeResource } from "../../auth/types.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { defineTool, type ToolError } from "../define-tool.js";

type ShowPlanOutput = { shown: false; reason: "plan_not_found" } | { shown: true; id: string };

const PLAN_ID_REGEX = /^pln-[a-f0-9]{8}$/;

export function createShowPlanTool(pool: Pool) {
    return defineTool({
        id: "show_plan",
        description:
            "Display a STORED plan in chat by its planId. The plan is loaded from storage and embedded in the card, " +
            "so the UI renders it directly. Use it to present the plan `generate_plan` just produced, and when the user " +
            "asks to see an earlier plan again. " +
            "Pick this tool by what you are referencing, not by how the output looks: " +
            "NOT for a plan you are drafting in conversation (that is `generate_plan`), NOT for other synthesized content " +
            "(`show_user`), NOT for analysis files (`show_file`). Never re-type a plan's steps into a `show_user` markdown " +
            "card — that renders a second, divergent copy of the same plan.",
        inputSchema: z.object({
            planId: z
                .string()
                .regex(PLAN_ID_REGEX, "planId must match pln-<8hex>")
                .describe("Plan ID (`pln-<8hex>`) from `generate_plan` (newly created) or `inspect_run` (each run carries the planId it ran)"),
            title: z.string().optional().describe("Optional card heading; defaults to the plan's own title"),
        }),
        execute: async ({ planId, title }, ctx): Promise<Result<ShowPlanOutput, ToolError>> => {
            const resourceId = scopeResource(ctx.session.scope).resourceId;
            // "Plan not found" / "plan no longer parses" are expected outcomes —
            // discriminated data variants the model reasons about, not errors.
            const card = unwrapOrThrow(await buildPlanCardData(pool, planId, resourceId, title));
            if (!card) return ok({ shown: false as const, reason: "plan_not_found" as const });

            await ctx.emit({
                type: "data-plan",
                source: ctx.session.provenance,
                data: card,
            });

            return ok({ shown: true as const, id: card.id });
        },
    });
}
