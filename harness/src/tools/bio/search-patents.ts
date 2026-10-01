/**
 * search_patents — patents from Amass PatentCore behind one `action`
 * discriminator: a search that returns no claims and no description, and the
 * details of one patent, with the claims and the description on request.
 *
 * The input is a flat object with an `action` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs a
 * top-level `"type":"object"`).
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import {
    describeAmassError,
    getPatentRecord,
    lookupPatentIds,
    searchPatentRecords,
    type AmassError,
    type PatentRecord,
    type PatentSummary,
} from "../lib/amass-client.js";
import { getAmassHeaders } from "../lib/amass-config.js";

/** The largest `limit` that still costs one search price (5 credits for each 20 records). */
const MAX_LIMIT = 20;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const IDENTIFIER_FIELDS = ["amassId", "publicationNumber", "applicationNumber"] as const;

function dateField(description: string) {
    return z.string().regex(ISO_DATE).optional().describe(`'search' only. ${description}, YYYY-MM-DD.`);
}

const inputSchema = z
    .object({
        action: z
            .enum(["search", "details"])
            .default("search")
            .describe("'search' (default) — find patents with `query`. 'details' — read one patent by ONE identifier."),
        query: z
            .string()
            .optional()
            .describe(
                "Required for 'search'. Keywords matched over the title, the abstract, the claims and the description: a compound, a target, a " +
                    "method or a formulation ('imatinib mesylate crystal form', 'KRAS G12C inhibitor').",
            ),
        assignee: z.array(z.string()).optional().describe("'search' only. Keep the patents of any of these assignees, e.g. ['Novartis']."),
        inventor: z.string().optional().describe("'search' only. Keep the patents of this inventor name."),
        cpcCodes: z.array(z.string()).optional().describe("'search' only. Keep these Cooperative Patent Classification codes, e.g. ['A61K', 'C07D']."),
        countryCode: z.array(z.string()).optional().describe("'search' only. Keep these jurisdictions, e.g. ['US', 'EP', 'WO']."),
        minPublicationDate: dateField("Earliest publication date"),
        maxPublicationDate: dateField("Latest publication date"),
        minFilingDate: dateField("Earliest filing date"),
        maxFilingDate: dateField("Latest filing date"),
        minPriorityDate: dateField("Earliest priority date — the effective date of the invention, the one for prior art"),
        maxPriorityDate: dateField("Latest priority date"),
        minGrantDate: dateField("Earliest grant date (drops each patent that was never granted)"),
        maxGrantDate: dateField("Latest grant date"),
        limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_LIMIT)
            .default(10)
            .describe(`'search' only. Max patents to return (default 10, max ${MAX_LIMIT}). There are no pages: narrow with the filters.`),
        amassId: z.string().optional().describe("'details' only. The Amass ID of one patent ('AMPC_…'), as a search returns it."),
        publicationNumber: z.string().optional().describe("'details' only. A publication number, e.g. 'US-10266485-B2'."),
        applicationNumber: z.string().optional().describe("'details' only. An application number; it can match more than one publication."),
        includeClaims: z.boolean().default(false).describe("'details' only. Add the full claims text. It can run to tens of thousands of characters."),
        includeDescription: z
            .boolean()
            .default(false)
            .describe("'details' only. Add the full description text. It is often longer than the claims; ask for it only when you must read it."),
    })
    .refine((d) => d.action !== "search" || (d.query !== undefined && d.query.trim().length > 0), {
        message: "query is required when action is 'search'.",
        path: ["query"],
    })
    .refine((d) => d.action !== "details" || IDENTIFIER_FIELDS.filter((field) => d[field] !== undefined).length === 1, {
        message: "action 'details' takes exactly one of amassId, publicationNumber, and applicationNumber.",
        path: ["action"],
    });

type PatentsOutput =
    { patents: PatentSummary[] } | { status: "found"; patent: PatentRecord } | { status: "not_found" } | { status: "ambiguous"; candidates: string[] };

/** A request that Amass rejected as invalid is the caller's to repair; every other failure is terminal. */
function failure(e: AmassError): Result<never, ToolError> {
    if (e.type === "invalid_input") return err({ error: describeAmassError(e), retryable: false, cause: e });
    throw new Error(describeAmassError(e));
}

export function createSearchPatentsTool(deps: { apiKey: string }) {
    return defineTool({
        id: "search_patents",
        description:
            "Patents from Amass PatentCore, across the patent offices (US, EP, WO, CN, JP, …), with one member for each patent family: the " +
            "title, the abstract, the assignees, the inventors, the CPC codes, the priority, filing, publication and grant dates, and the citation " +
            "counts. Answers 'who patented this compound, target or method, and when?' and 'what does this patent claim?'.\n" +
            "action 'search' (the default) returns patents with no claims and no description. action 'details' takes ONE identifier and returns " +
            "the patent with its family members; set includeClaims or includeDescription for the full text.\n" +
            "ACCEPTED IDENTIFIERS for 'details': amassId ('AMPC_…'), publicationNumber ('US-10266485-B2') or applicationNumber.\n" +
            "status 'not_found' is a valid no-data answer and status 'ambiguous' lists the candidate amassIds of an application number that " +
            "matches more than one publication — call 'details' again with one of them. An empty search is also valid no-data. Do not retry any " +
            "of these unchanged.\n" +
            "Requires AMASS_API_KEY — a missing key fails terminally: do NOT retry, tell the user the key needs configuring and proceed without " +
            "Amass patent data. Every call spends the user's Amass credits.",
        inputSchema,
        describeCall: "none",
        execute: async (input): Promise<Result<PatentsOutput, ToolError>> => {
            const headers = getAmassHeaders(deps.apiKey);

            if (input.action === "search") {
                const patents = await searchPatentRecords(
                    {
                        query: input.query!,
                        limit: input.limit,
                        ...(input.assignee ? { assignee: input.assignee } : {}),
                        ...(input.inventor ? { inventor: input.inventor } : {}),
                        ...(input.cpcCodes ? { cpcCodes: input.cpcCodes } : {}),
                        ...(input.countryCode ? { countryCode: input.countryCode } : {}),
                        ...(input.minPublicationDate ? { minPublicationDate: input.minPublicationDate } : {}),
                        ...(input.maxPublicationDate ? { maxPublicationDate: input.maxPublicationDate } : {}),
                        ...(input.minFilingDate ? { minFilingDate: input.minFilingDate } : {}),
                        ...(input.maxFilingDate ? { maxFilingDate: input.maxFilingDate } : {}),
                        ...(input.minPriorityDate ? { minPriorityDate: input.minPriorityDate } : {}),
                        ...(input.maxPriorityDate ? { maxPriorityDate: input.maxPriorityDate } : {}),
                        ...(input.minGrantDate ? { minGrantDate: input.minGrantDate } : {}),
                        ...(input.maxGrantDate ? { maxGrantDate: input.maxGrantDate } : {}),
                    },
                    headers,
                );
                if (patents.isErr()) return failure(patents.error);
                return ok({ patents: patents.value });
            }

            let amassId = input.amassId;
            if (amassId === undefined) {
                const ids = await lookupPatentIds(
                    {
                        ...(input.publicationNumber === undefined ? {} : { publicationNumber: input.publicationNumber }),
                        ...(input.applicationNumber === undefined ? {} : { applicationNumber: input.applicationNumber }),
                    },
                    headers,
                );
                if (ids.isErr()) return failure(ids.error);
                if (ids.value.length === 0) return ok({ status: "not_found" as const });
                if (ids.value.length > 1) return ok({ status: "ambiguous" as const, candidates: ids.value });
                amassId = ids.value[0]!;
            }

            const patent = await getPatentRecord(amassId, { claims: input.includeClaims, description: input.includeDescription }, headers);
            if (patent.isErr()) return failure(patent.error);
            return ok(patent.value ? { status: "found" as const, patent: patent.value } : { status: "not_found" as const });
        },
    });
}
