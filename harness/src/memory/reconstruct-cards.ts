/**
 * Read-path reconstruction of display cards from a persisted turn.
 *
 * `show_plan` / `show_user` / `execute_plan` / `iterate_report` emit
 * `data-plan` / `data-presentation` / `data-run-card` / `data-preview` cards
 * live over the chat SSE stream, but only the Anthropic transcript is
 * persisted. On reload, `content-to-cortex` calls this resolver for each
 * `tool_use` block: a recognised display tool yields its card (rebuilt via the
 * shared `card-builders`); anything else yields `null` and falls back to a
 * generic `tool-call` chip. Keyed by the analysis `Pool` + id (plan / run) or
 * the `sessionsBasePath` (preview, filesystem-backed) so the card can be
 * re-loaded.
 */

import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { CortexPart } from "@inflexa-ai/harness/contracts/message.js";
import type { Pool } from "pg";

import { unwrapOrThrow } from "../lib/result.js";
import { buildPlanCardData, buildPresentationCardData, buildPreviewCardData, buildRunCardData } from "./card-builders.js";

export type ToolCardResolver = (block: ContentBlockParam) => Promise<CortexPart | null>;

export function createCardResolver(pool: Pool, analysisId: string, sessionsBasePath: string): ToolCardResolver {
    return async (block) => {
        if (block.type !== "tool_use") return null;
        const input = (block.input ?? {}) as Record<string, unknown>;

        // The harness tool id is `iterate_report`; legacy transcripts carry
        // `iterateReport` — accept both.
        if (block.name === "iterate_report" || block.name === "iterateReport") {
            const report = (input.report ?? null) as { title?: unknown } | null;
            const card = await buildPreviewCardData(sessionsBasePath, analysisId, {
                previewId: typeof input.previewId === "string" ? input.previewId : undefined,
                title: report && typeof report.title === "string" ? report.title : undefined,
                format: input.format === "pdf" || input.format === "html" ? input.format : undefined,
            });
            return card ? ({ type: "data-preview", ...card } as CortexPart) : null;
        }

        if (block.name === "show_user") {
            const card = buildPresentationCardData(input);
            return card ? ({ type: "data-presentation", ...card } as CortexPart) : null;
        }

        if (block.name === "show_plan") {
            const planId = typeof input.planId === "string" ? input.planId : null;
            if (!planId) return null;
            const title = typeof input.title === "string" ? input.title : undefined;
            const card = unwrapOrThrow(await buildPlanCardData(pool, planId, analysisId, title));
            return card ? ({ type: "data-plan", ...card } as CortexPart) : null;
        }

        if (block.name === "execute_plan") {
            const planId = typeof input.planId === "string" ? input.planId : null;
            if (!planId) return null;
            const card = unwrapOrThrow(await buildRunCardData(pool, { planId, analysisId }));
            return card ? ({ type: "data-run-card", ...card } as CortexPart) : null;
        }

        return null;
    };
}
