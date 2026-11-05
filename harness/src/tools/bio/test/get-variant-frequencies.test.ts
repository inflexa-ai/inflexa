import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";

import { restoreFetch, stubFetch, type SentRequest } from "../../__fixtures__/fetch-stub.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { readFixture } from "../../lib/__fixtures__/fixture-runner.js";
import { GNOMAD_MAX_VARIANTS, GnomadVariantSchema, type GnomadDataset } from "../../lib/gnomad-client.js";
import { createRunScriptTool } from "../../script/run-script.js";
import { getVariantFrequenciesTool } from "../get-variant-frequencies.js";

/** Each request that the tool sent, in call order. */
let requests: SentRequest[] = [];

beforeEach(() => {
    requests = [];
});

afterEach(restoreFetch);

function answerWith(status: number, body: unknown): void {
    requests = stubFetch(() => ({ status, body }));
}

async function call(variantIds: string[], dataset: GnomadDataset = "gnomad_r4"): ReturnType<typeof getVariantFrequenciesTool.execute> {
    return getVariantFrequenciesTool.execute({ variantIds, dataset }, makeToolContext().ctx);
}

const FOUND = "1-55051215-G-GA";
const MISSING = "1-1-A-T";

describe("get_variant_frequencies", () => {
    it("gives the genome and the exome frequencies of a found variant, and lists a miss in notFound", async () => {
        answerWith(200, readFixture("gnomad", "batch-r4.json"));

        const out = (await call([FOUND, MISSING]))._unsafeUnwrap();

        expect(out.dataset).toBe("gnomad_r4");
        expect(out.referenceGenome).toBe("GRCh38");
        expect(out.notFound).toEqual([MISSING]);
        expect(out.variants.map((variant) => ({ query: variant.query, genomeAf: variant.genome?.af, exomeAf: variant.exome?.af }))).toEqual([
            { query: FOUND, genomeAf: 0.004772721304587589, exomeAf: 0.0006317119393556538 },
        ]);
    });

    it("posts one batch, trimmed and without a duplicate, with the body of the manifest", async () => {
        answerWith(200, readFixture("gnomad", "batch-r4.json"));
        const manifest = z.object({ "batch-r4.json": z.object({ url: z.string(), body: z.string() }) }).parse(readFixture("gnomad", "manifest.json"));

        (await call([` ${FOUND} `, FOUND, MISSING]))._unsafeUnwrap();

        expect(requests).toEqual([{ url: manifest["batch-r4.json"].url, method: "POST", body: manifest["batch-r4.json"].body }]);
    });

    it("gives an empty data variant when no variant is found, not an error", async () => {
        answerWith(200, { errors: [{ message: "Variant not found" }], data: { v0: null } });

        expect((await call([MISSING]))._unsafeUnwrap()).toEqual({ dataset: "gnomad_r4", referenceGenome: "GRCh38", variants: [], notFound: [MISSING] });
    });

    it("lists a variant outside a subset in notFound, and keeps the other records of the batch", async () => {
        const found = z.object({ data: z.object({ v0: GnomadVariantSchema }) }).parse(readFixture("gnomad", "batch-r4.json")).data.v0;
        answerWith(200, { errors: [{ message: "Variant not found in selected subset." }], data: { v0: found, v1: null } });

        const out = (await call([FOUND, MISSING], "gnomad_r4_non_ukb"))._unsafeUnwrap();

        expect(out.notFound).toEqual([MISSING]);
        expect(out.variants.map((variant) => variant.variantId)).toEqual([FOUND]);
    });

    it("gives a null af for a callset with no called allele, not the 0 that gnomAD sends", async () => {
        const genome = { ac: 0, an: 0, af: 0, populations: [] };
        answerWith(200, { data: { v0: { variant_id: MISSING, rsids: [], genome, exome: null } } });

        const out = (await call([MISSING]))._unsafeUnwrap();

        expect(out.variants[0]?.genome).toEqual({ ac: 0, an: 0, af: null, populations: [] });
    });

    it("throws for an answer without the alias of a variant, and reports no miss", async () => {
        answerWith(200, { data: {} });

        await expect(call([MISSING])).rejects.toThrow(`gnomAD gave no answer for ${MISSING}`);
    });

    it("gives the reference genome of a GRCh37 dataset", async () => {
        answerWith(200, readFixture("gnomad", "batch-exac.json"));

        const out = (await call(["1-55516888-G-GA"], "exac"))._unsafeUnwrap();

        expect(out.referenceGenome).toBe("GRCh37");
        expect(out.variants[0]?.genome).toBeNull();
    });

    it("throws the message of the rate limit", async () => {
        answerWith(400, { errors: [{ message: "Query rate limit exceeded. Please try again in a few minutes." }] });

        await expect(call([FOUND])).rejects.toThrow("Query rate limit exceeded");
    });

    it("throws an error entry that is not a miss, even beside a miss", async () => {
        answerWith(200, { errors: [{ message: "Variant not found" }, { message: "Invalid variant ID" }], data: { v0: null, v1: null } });

        await expect(call([FOUND, MISSING])).rejects.toThrow("gnomAD: Invalid variant ID");
    });

    it("makes execute throw on a 5xx", async () => {
        answerWith(500, "<h1>Server Error</h1>");

        await expect(call([FOUND])).rejects.toThrow("HTTP 500");
    });

    it("refuses a malformed variant ID, an empty list, and a list past the cap", () => {
        const parse = (variantIds: string[]): boolean => getVariantFrequenciesTool.inputSchema.safeParse({ variantIds }).success;

        for (const id of ["rs527413419", "M-1-A-G", "23-1-A-T", "1-0-A-T", "1-1.5-A-T", "1-0.5-A-T", "1-01-A-T", "1-55051215-G", "1-55051215-G-N"])
            expect(parse([id])).toBe(false);
        expect(parse([])).toBe(false);
        expect(parse(Array.from({ length: GNOMAD_MAX_VARIANTS + 1 }, (_, i) => `1-${i + 1}-A-T`))).toBe(false);
        expect(parse(["chr1:55051215:g:ga", "X-100-A-T"])).toBe(true);
        expect(getVariantFrequenciesTool.inputSchema.parse({ variantIds: [FOUND] }).dataset).toBe("gnomad_r4");
    });
});

describe("get_variant_frequencies — describeCall", () => {
    it("names the dataset and each variant of a small batch", () => {
        expect(getVariantFrequenciesTool.describeCall?.({ variantIds: [FOUND, MISSING], dataset: "gnomad_r4" })).toBe(`gnomad_r4: ${FOUND}, ${MISSING}`);
    });

    it("gives the count and a sample of a large batch", () => {
        const variantIds = Array.from({ length: 5 }, (_, i) => `1-${i + 1}-A-T`);

        expect(getVariantFrequenciesTool.describeCall?.({ variantIds, dataset: "gnomad_r2_1" })).toBe("gnomad_r2_1: 5 variants: 1-1-A-T, 1-2-A-T, 1-3-A-T, …");
    });
});

describe("get_variant_frequencies — in a script", () => {
    it("shows its whole result type in the catalog of run_script", () => {
        const catalog = createRunScriptTool([getVariantFrequenciesTool]).description;
        const entry = catalog.slice(catalog.indexOf("get_variant_frequencies(args:"));

        expect(entry).not.toContain("Promise<unknown>");
        expect(entry).toContain('referenceGenome: "GRCh38" | "GRCh37";');
        expect(entry).toContain("af: number | null;");
        expect(entry).toContain("notFound: Array<string>;");
    });

    it("gives a script the frequencies, with the default dataset", async () => {
        answerWith(200, readFixture("gnomad", "batch-r4.json"));
        const runScript = createRunScriptTool([getVariantFrequenciesTool]);

        const out = (
            await runScript.execute(
                {
                    code: `
                        const res = await tools.get_variant_frequencies({ variantIds: ["${FOUND}", "${MISSING}"] });
                        return { notFound: res.notFound, rare: res.variants.filter((v) => (v.genome?.af ?? 0) < 0.01).map((v) => v.variantId) };
                    `,
                },
                makeToolContext().ctx,
            )
        )._unsafeUnwrap();

        expect(out.error).toBeUndefined();
        expect(out.value).toEqual({ notFound: [MISSING], rare: [FOUND] });
    });

    it("sends one gnomAD request at a time when a script calls the tool in parallel", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        globalThis.fetch = Object.assign(
            async (): Promise<Response> => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await Bun.sleep(5);
                inFlight -= 1;
                return Response.json({ errors: [{ message: "Variant not found" }], data: { v0: null } });
            },
            { preconnect: fetch.preconnect },
        );
        const runScript = createRunScriptTool([getVariantFrequenciesTool]);

        const out = (
            await runScript.execute(
                {
                    code: `
                        const ids = ["1-1-A-T", "1-2-A-T", "1-3-A-T"];
                        const all = await Promise.all(ids.map((id) => tools.get_variant_frequencies({ variantIds: [id] })));
                        return all.flatMap((res) => res.notFound);
                    `,
                },
                makeToolContext().ctx,
            )
        )._unsafeUnwrap();

        expect(out.value).toEqual(["1-1-A-T", "1-2-A-T", "1-3-A-T"]);
        expect(maxInFlight).toBe(1);
    });
});
