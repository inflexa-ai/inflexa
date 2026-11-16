/**
 * `knowledge_claims` — the statement and the evidence of a claim, on demand.
 *
 * The recommend answer gives the model a heading of each claim: the id, the
 * title, the strength, and the severity. The full views ride in the call
 * record of the answer, and the fold of that record keeps them on a shelf
 * that the recommend tool and this tool share. This tool reads the shelf
 * and never calls the service: a claim id names the content hash of its
 * rule, thus a kept view stays true for the id.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import type { RecommendResponse } from "./client.js";

/** The full view of one claim, as the service gave it. */
export type KeptClaim = RecommendResponse["claims"][number];

/** The full claim views of the recommend answers that a conversation saw, by claim id. */
export type ClaimShelf = {
    /** Keep each view of an answer. A later view of one claim id replaces the earlier view. */
    keep(claims: readonly KeptClaim[]): void;
    get(id: string): KeptClaim | undefined;
};

/** The views one shelf keeps. A full answer holds about 25 claims, thus the bound only stops the growth of a long-lived host. */
export const CLAIM_SHELF_MAX = 1024;

export function createClaimShelf(): ClaimShelf {
    const views = new Map<string, KeptClaim>();
    return {
        keep: (claims) => {
            for (const claim of claims) {
                views.delete(claim.id);
                views.set(claim.id, claim);
            }
            for (const id of views.keys()) {
                if (views.size <= CLAIM_SHELF_MAX) break;
                views.delete(id);
            }
        },
        get: (id) => views.get(id),
    };
}

/** The claims of one call. The largest claim of a full answer gives about 2,700 characters, thus 8 views stay under the cut of a tool result. */
export const CLAIMS_PER_CALL_MAX = 8;

const KnowledgeClaimsInputSchema = z.object({
    claims: z
        .array(z.string().min(1))
        .min(1)
        .max(CLAIMS_PER_CALL_MAX)
        .describe("The claim ids to read, as the `knowledge_recommend` answer gives them, for example `R-0056@3eed`."),
});

export type KnowledgeClaimsOutput = {
    readonly claims: readonly KeptClaim[];
    /** The requested ids that the shelf does not hold. Absent when the shelf holds each one. */
    missing?: readonly string[];
};

export type KnowledgeClaimsDeps = {
    /** The shelf that the recommend tool of the same conversation fills. */
    readonly shelf: ClaimShelf;
};

export function createKnowledgeClaimsTool(deps: KnowledgeClaimsDeps): Tool<z.infer<typeof KnowledgeClaimsInputSchema>, KnowledgeClaimsOutput> {
    return defineTool({
        id: "knowledge_claims",
        description:
            "Get the statement and the evidence of claims from a `knowledge_recommend` answer, by claim id. " +
            "The recommend answer gives only the id, the title, the strength, and the severity of each claim. " +
            "Read a claim here when its title does not show whether its rule fits the design or the question, and before you depart from a step that cites it. " +
            `Send up to ${CLAIMS_PER_CALL_MAX} claim ids in one call. ` +
            "The answer holds the full view of each claim: the statement, the evidence (the DOI or the PubMed id, the title, the year, and the direction), and the license. " +
            "The host reads the recommend answers it kept, and it does not call the service. " +
            "`missing` lists each id that the host does not hold; call `knowledge_recommend` with the situation again, then read the claim.",
        inputSchema: KnowledgeClaimsInputSchema,
        view: "none",
        describeCall: ({ claims }) => claims.join(", "),
        describeResult: (_input, result: KnowledgeClaimsOutput) =>
            result.missing === undefined ? `${result.claims.length} claims` : `${result.claims.length} claims, ${result.missing.length} missing`,
        execute: (input): Promise<Result<KnowledgeClaimsOutput, ToolError>> => {
            const claims: KeptClaim[] = [];
            const missing: string[] = [];
            for (const id of new Set(input.claims)) {
                const view = deps.shelf.get(id);
                if (view === undefined) missing.push(id);
                else claims.push(view);
            }
            const output: KnowledgeClaimsOutput = { claims };
            if (missing.length > 0) output.missing = missing;
            return Promise.resolve(ok(output));
        },
    });
}
