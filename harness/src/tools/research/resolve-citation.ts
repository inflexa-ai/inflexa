import { ok } from "neverthrow";

import { CitationInputSchema, type CitationResolver } from "../../citations/types.js";
import { defineTool, type Tool } from "../define-tool.js";

export function createResolveCitationTool(resolver: CitationResolver): Tool {
    return defineTool({
        id: "resolve_citation",
        description:
            "Verify one supplied citation against applicable bibliographic authorities. " +
            "Use this for 'does this reference exist and does its metadata agree?', not for topical literature discovery. " +
            "Returns source-labelled records, field comparisons, conflicts, coverage, and one of verified, metadata_mismatch, " +
            "not_found, unverifiable, or inconclusive. Source failure never becomes not_found.",
        inputSchema: CitationInputSchema,
        describeCall: ({ citation }) => `verify ${citation}`,
        execute: async (input, ctx) => ok(await resolver.resolveOne(input, { signal: ctx.signal })),
    });
}
