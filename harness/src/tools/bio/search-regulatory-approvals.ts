/**
 * search_regulatory_approvals — the FDA and EMA drug authorizations of Amass
 * RegulatoryCore, with the parsed sections of their labels, reviews, SmPCs and
 * EPARs, behind one `action` discriminator.
 *
 * The three actions read the text in three sizes: `search` gives the matched
 * excerpts, `details` the table of contents, and `section` the full text of one
 * section. Thus an agent reads only the section that it cites.
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
    getRegulatoryRecord,
    getRegulatorySection,
    lookupRegulatoryIds,
    MAX_MATCHED_SECTIONS,
    REGULATORY_AGENCIES,
    REGULATORY_AUTHORIZATION_STATUSES,
    REGULATORY_DESIGNATIONS,
    REGULATORY_MOLECULE_TYPES,
    searchRegulatoryRecords,
    type AmassError,
    type AuthorizationRecord,
    type AuthorizationSearchRow,
    type RegulatorySection,
} from "../lib/amass-client.js";
import { getAmassHeaders } from "../lib/amass-config.js";

/** The largest `limit` that still costs one search price (5 credits for each 20 records). */
const MAX_LIMIT = 20;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const IDENTIFIER_FIELDS = ["amassId", "fdaApplicationNumber", "emaProductNumber", "ndc", "splSetId"] as const;

const inputSchema = z
    .object({
        action: z
            .enum(["search", "details", "section"])
            .default("search")
            .describe(
                "'search' (default) — find authorizations with `query`. 'details' — read one authorization and the table of contents of its " +
                    "source documents, by ONE identifier. 'section' — read the full text of one document section, by `amassId` and `documentSectionId`.",
            ),
        query: z
            .string()
            .optional()
            .describe(
                "Required for 'search'. Free text matched across the product metadata and the full text of the source documents: a brand or " +
                    "substance name ('Gleevec', 'imatinib'), an indication, or a label topic ('hepatotoxicity', 'QT prolongation').",
            ),
        agency: z.array(z.enum(REGULATORY_AGENCIES)).optional().describe("'search' only. Keep the authorizations of these agencies. Omit for both."),
        authorizationStatus: z
            .array(z.enum(REGULATORY_AUTHORIZATION_STATUSES))
            .optional()
            .describe("'search' only. Keep these authorization statuses, e.g. ['ACTIVE'] or the withdrawals. Omit for every status."),
        moleculeType: z.array(z.enum(REGULATORY_MOLECULE_TYPES)).optional().describe("'search' only. Keep these molecule types."),
        hasDesignation: z
            .array(z.enum(REGULATORY_DESIGNATIONS))
            .optional()
            .describe("'search' only. Keep the authorizations that carry any of these designations."),
        isOrphan: z.boolean().optional().describe("'search' only. true keeps the FDA Orphan Drug / EMA Orphan Medicine authorizations; false drops them."),
        minAuthorizationDate: z.string().regex(ISO_DATE).optional().describe("'search' only. Earliest authorization date, YYYY-MM-DD."),
        maxAuthorizationDate: z.string().regex(ISO_DATE).optional().describe("'search' only. Latest authorization date, YYYY-MM-DD."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_LIMIT)
            .default(10)
            .describe(`'search' only. Max authorizations to return (default 10, max ${MAX_LIMIT}). There are no pages: narrow with the filters.`),
        amassId: z
            .string()
            .optional()
            .describe(
                "The Amass ID of one authorization ('AMRC_…'), as a search returns it. With 'search' it limits the full-text match to the documents " +
                    "of that one record. With 'details' it is the identifier. 'section' requires it.",
            ),
        fdaApplicationNumber: z
            .string()
            .optional()
            .describe("'details' only. An FDA application number: 'NDA021588', 'BLA125085', or the bare '021588' (each prefix is tried)."),
        emaProductNumber: z.string().optional().describe("'details' only. An EMA product number, e.g. 'EMEA/H/C/000406'."),
        ndc: z.string().optional().describe("'details' only. A US National Drug Code, as the product code '0078-0401' or the package code '0078-0401-05'."),
        splSetId: z.string().optional().describe("'details' only. The Set ID of an FDA Structured Product Label."),
        documentSectionId: z
            .string()
            .optional()
            .describe("Required for 'section'. One section ID ('AMRCDS_…') from a search excerpt or from the table of contents of 'details'."),
    })
    .refine((d) => d.action !== "search" || (d.query !== undefined && d.query.trim().length > 0), {
        message: "query is required when action is 'search'.",
        path: ["query"],
    })
    .refine((d) => d.action !== "details" || IDENTIFIER_FIELDS.filter((field) => d[field] !== undefined).length === 1, {
        message: "action 'details' takes exactly one of amassId, fdaApplicationNumber, emaProductNumber, ndc, and splSetId.",
        path: ["action"],
    })
    .refine((d) => d.action !== "section" || (d.amassId !== undefined && d.documentSectionId !== undefined), {
        message: "action 'section' requires both amassId and documentSectionId.",
        path: ["documentSectionId"],
    });

type RegulatoryApprovalsOutput =
    | { authorizations: AuthorizationSearchRow[] }
    | { status: "found"; authorization: AuthorizationRecord }
    | { status: "found"; section: RegulatorySection }
    | { status: "not_found" }
    | { status: "ambiguous"; candidates: string[] };

/** A request that Amass rejected as invalid is the caller's to repair; every other failure is terminal. */
function failure(e: AmassError): Result<never, ToolError> {
    if (e.type === "invalid_input") return err({ error: describeAmassError(e), retryable: false, cause: e });
    throw new Error(describeAmassError(e));
}

export function createSearchRegulatoryApprovalsTool(deps: { apiKey: string }) {
    return defineTool({
        id: "search_regulatory_approvals",
        description:
            "The drug authorizations of the U.S. Food and Drug Administration (FDA) and the European Medicines Agency (EMA), from Amass " +
            "RegulatoryCore: the status, the approved indication, the marketing authorization holder, the dates, the orphan status and the " +
            "designations (breakthrough, PRIME, accelerated approval, …), plus the full text of the source documents — FDA labels and reviews, " +
            "EMA SmPCs and EPARs — parsed into sections. Answers 'is this drug approved, where, and for what?', 'what does its label say about X?', " +
            "and 'which drugs carry this designation?'.\n" +
            "action 'search' (the default) returns authorizations, each with at most " +
            `${MAX_MATCHED_SECTIONS} matched document sections (a matchedText excerpt each) and matchedSectionCount, the true count. ` +
            "action 'details' takes ONE identifier and returns the authorization with the FDA or EMA specifics (application number, NDCs, SmPC, " +
            "withdrawal) and the table of contents of its documents, with no text. action 'section' returns the full text of one section. Read in " +
            "that order: the excerpt, then the table of contents, then only the section to cite.\n" +
            "ACCEPTED IDENTIFIERS for 'details': amassId ('AMRC_…'), fdaApplicationNumber ('NDA021588'; a bare number is tried as NDA, BLA and " +
            "ANDA), emaProductNumber, ndc (product or package code) or splSetId.\n" +
            "status 'not_found' is a valid no-data answer and status 'ambiguous' lists the candidate amassIds of an identifier that matches more " +
            "than one record — call 'details' again with one of them. An empty search is also valid no-data. Do not retry any of these unchanged.\n" +
            "Requires AMASS_API_KEY — a missing key fails terminally: do NOT retry, tell the user the key needs configuring and proceed without " +
            "Amass regulatory data. Every call spends the user's Amass credits.",
        inputSchema,
        describeCall: "none",
        execute: async (input): Promise<Result<RegulatoryApprovalsOutput, ToolError>> => {
            const headers = getAmassHeaders(deps.apiKey);

            if (input.action === "search") {
                const rows = await searchRegulatoryRecords(
                    {
                        query: input.query!,
                        limit: input.limit,
                        ...(input.agency ? { agency: input.agency } : {}),
                        ...(input.authorizationStatus ? { authorizationStatus: input.authorizationStatus } : {}),
                        ...(input.moleculeType ? { moleculeType: input.moleculeType } : {}),
                        ...(input.hasDesignation ? { hasDesignation: input.hasDesignation } : {}),
                        ...(input.isOrphan === undefined ? {} : { isOrphan: input.isOrphan }),
                        ...(input.minAuthorizationDate ? { minAuthorizationDate: input.minAuthorizationDate } : {}),
                        ...(input.maxAuthorizationDate ? { maxAuthorizationDate: input.maxAuthorizationDate } : {}),
                        ...(input.amassId ? { amassId: input.amassId } : {}),
                    },
                    headers,
                );
                if (rows.isErr()) return failure(rows.error);
                return ok({ authorizations: rows.value });
            }

            if (input.action === "section") {
                const section = await getRegulatorySection(input.amassId!, input.documentSectionId!, headers);
                if (section.isErr()) return failure(section.error);
                return ok(section.value ? { status: "found" as const, section: section.value } : { status: "not_found" as const });
            }

            let amassId = input.amassId;
            if (amassId === undefined) {
                const ids = await lookupRegulatoryIds(
                    {
                        ...(input.fdaApplicationNumber === undefined ? {} : { fdaApplicationNumber: input.fdaApplicationNumber }),
                        ...(input.emaProductNumber === undefined ? {} : { emaProductNumber: input.emaProductNumber }),
                        ...(input.ndc === undefined ? {} : { ndc: input.ndc }),
                        ...(input.splSetId === undefined ? {} : { splSetId: input.splSetId }),
                    },
                    headers,
                );
                if (ids.isErr()) return failure(ids.error);
                if (ids.value.length === 0) return ok({ status: "not_found" as const });
                if (ids.value.length > 1) return ok({ status: "ambiguous" as const, candidates: ids.value });
                amassId = ids.value[0]!;
            }

            const record = await getRegulatoryRecord(amassId, headers);
            if (record.isErr()) return failure(record.error);
            return ok(record.value ? { status: "found" as const, authorization: record.value } : { status: "not_found" as const });
        },
    });
}
