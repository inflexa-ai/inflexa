/**
 * Live Amass contract check: RegulatoryCore and PatentCore.
 *
 * Each request spends credits of the key: a search costs 5, and a lookup or a
 * get costs 1. One run of this file costs 12 credits.
 *
 * Gated on `AMASS_API_KEY`. Without the key the block skips, and no test fails.
 */

import { describe, expect, test } from "bun:test";

import { makeToolContext } from "../../../tools/__fixtures__/tool-context.js";
import { createSearchPatentsTool } from "../../../tools/bio/search-patents.js";
import { createSearchRegulatoryApprovalsTool } from "../../../tools/bio/search-regulatory-approvals.js";

const KEY = process.env.AMASS_API_KEY;

describe.skipIf(!KEY)("live Amass", () => {
    const regulatory = createSearchRegulatoryApprovalsTool({ apiKey: KEY ?? "" });
    const patents = createSearchPatentsTool({ apiKey: KEY ?? "" });

    test("a regulatory search passes the schema and carries matched sections", async () => {
        const { ctx } = makeToolContext();
        // `parse` hands back `unknown` (`Tool` erases the schema generic); the input type and the schema share one declaration.
        const result = (await regulatory.execute(regulatory.inputSchema.parse({ query: "imatinib", limit: 1 }), ctx))._unsafeUnwrap();

        if (!("authorizations" in result)) throw new Error("expected a search answer");
        expect(result.authorizations).toHaveLength(1);
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the assertion's grammar: the expected output shape has no builtin matcher.
        expect(result.authorizations[0].amassId).toMatch(/^AMRC_/);
        expect(result.authorizations[0].matchedSectionCount).toBeGreaterThanOrEqual(0);
    }, 60_000);

    test("a bare FDA application number resolves to one record with its table of contents", async () => {
        const { ctx } = makeToolContext();
        // `parse` hands back `unknown` (`Tool` erases the schema generic); the input type and the schema share one declaration.
        // SAFETY: the value is test-controlled — a fixture, a double answer, or the unit under test answering the input this test built — so the cast names a shape the test itself determines.
        const result = (await regulatory.execute(regulatory.inputSchema.parse({ action: "details", fdaApplicationNumber: "021588" }), ctx))._unsafeUnwrap();

        if (!("authorization" in result)) throw new Error(`expected an authorization, got ${JSON.stringify(result)}`);
        expect(result.authorization.fdaDetails?.applicationNumber).toBe("NDA021588");
        expect(result.authorization.sectionCount).toBeGreaterThan(0);
    }, 60_000);

    test("a patent search passes the schema and carries no claims", async () => {
        const { ctx } = makeToolContext();
        // `parse` hands back `unknown` (`Tool` erases the schema generic); the input type and the schema share one declaration.
        const result = (await patents.execute(patents.inputSchema.parse({ query: "imatinib mesylate crystal", limit: 1 }), ctx))._unsafeUnwrap();

        if (!("patents" in result)) throw new Error("expected a search answer");
        expect(result.patents).toHaveLength(1);
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the assertion's grammar: the expected output shape has no builtin matcher.
        expect(result.patents[0].amassId).toMatch(/^AMPC_/);
        expect(result.patents[0]).not.toHaveProperty("claims");
    }, 60_000);
});
