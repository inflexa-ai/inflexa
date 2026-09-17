import { afterEach, describe, expect, it } from "bun:test";

import { readFixture } from "../lib/__fixtures__/fixture-runner.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { alphafoldPredictionTool } from "./alphafold-prediction.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubResponse(status: number, body: unknown): void {
    globalThis.fetch = (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("alphafoldPrediction — an accession with a model", () => {
    it("returns the model metadata, confidence, and artifact URLs", async () => {
        stubResponse(200, readFixture("alphafold", "prediction-P69905.json"));

        const { ctx } = makeToolContext();
        const out = (await alphafoldPredictionTool.execute({ uniprotAccession: "P69905" }, ctx))._unsafeUnwrap();

        expect(out).toEqual({
            found: true,
            uniprotAccession: "P69905",
            uniprotDescription: "Hemoglobin subunit alpha",
            latestVersion: 6,
            modelCreatedDate: "2025-08-01T00:00:00Z",
            globalMetricValue: 98.06,
            fractionPlddtVeryLow: 0.0,
            fractionPlddtLow: 0.007,
            fractionPlddtConfident: 0.0,
            fractionPlddtVeryHigh: 0.993,
            pdbUrl: "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.pdb",
            cifUrl: "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif",
            paeImageUrl: "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-predicted_aligned_error_v6.png",
            plddtDocUrl: "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-confidence_v6.json",
            paeDocUrl: "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-predicted_aligned_error_v6.json",
            amAnnotationsUrl: "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-aa-substitutions.csv",
        });
    });

    it("selects the entry matching the queried accession out of a multi-isoform response", async () => {
        stubResponse(200, readFixture("alphafold", "prediction-P38398.json"));

        const { ctx } = makeToolContext();
        const out = (await alphafoldPredictionTool.execute({ uniprotAccession: "P38398" }, ctx))._unsafeUnwrap();

        expect(out.found).toBe(true);
        if (out.found) {
            expect(out.uniprotAccession).toBe("P38398");
            expect(out.globalMetricValue).toBe(41.59);
            // A largely-disordered protein still reports its real mean pLDDT.
            expect(out.fractionPlddtVeryLow).toBeGreaterThan(out.fractionPlddtVeryHigh);
        }
    });

    it("selects the isoform entry when the queried accession names one", async () => {
        stubResponse(200, readFixture("alphafold", "prediction-P38398.json"));

        const { ctx } = makeToolContext();
        const out = (await alphafoldPredictionTool.execute({ uniprotAccession: "P38398-8" }, ctx))._unsafeUnwrap();

        expect(out.found).toBe(true);
        if (out.found) {
            expect(out.uniprotAccession).toBe("P38398-8");
            // The isoform entry carries no AlphaMissense annotation link.
            expect(out.amAnnotationsUrl).toBeUndefined();
            // But it does carry the per-residue confidence document, which is
            // the field that locates the disorder of the isoform.
            expect(out.plddtDocUrl).toBe("https://alphafold.ebi.ac.uk/files/AF-P38398-8-F1-confidence_v6.json");
        }
    });
});

describe("alphafoldPrediction — an accession with no model", () => {
    // AlphaFold splits absence over two status codes, and both mean the same
    // thing to a caller: a well-formed accession it holds no model for answers
    // 404, and an identifier it cannot parse answers 400.
    it("returns found: false on a 404, not an is_error", async () => {
        stubResponse(404, {});

        const { ctx } = makeToolContext();
        const out = (await alphafoldPredictionTool.execute({ uniprotAccession: "Q0Q0Q0" }, ctx))._unsafeUnwrap();

        expect(out).toEqual({ found: false, uniprotAccession: "Q0Q0Q0" });
    });

    it("returns found: false on a 400, not an is_error", async () => {
        stubResponse(400, { error: "Invalid identifier format. Please use a UniProt accession or a supported AlphaFold DB ID." });

        const { ctx } = makeToolContext();
        const out = (await alphafoldPredictionTool.execute({ uniprotAccession: "NOTANACC" }, ctx))._unsafeUnwrap();

        expect(out).toEqual({ found: false, uniprotAccession: "NOTANACC" });
    });

    it("echoes the trimmed accession, not the padded argument", async () => {
        stubResponse(404, {});

        const { ctx } = makeToolContext();
        const out = (await alphafoldPredictionTool.execute({ uniprotAccession: "  P38398  " }, ctx))._unsafeUnwrap();

        expect(out).toEqual({ found: false, uniprotAccession: "P38398" });
    });
});

describe("alphafoldPrediction — an upstream failure", () => {
    it("throws on a 5xx", async () => {
        stubResponse(500, "upstream down");

        const { ctx } = makeToolContext();
        await expect(alphafoldPredictionTool.execute({ uniprotAccession: "P38398" }, ctx)).rejects.toThrow();
    });

    it("throws on a 403, because a refusal is not an absence", async () => {
        stubResponse(403, "<!doctype html><title>403</title>403 Forbidden");

        const { ctx } = makeToolContext();
        await expect(alphafoldPredictionTool.execute({ uniprotAccession: "P38398" }, ctx)).rejects.toThrow("HTTP 403");
    });
});

describe("alphafoldPrediction — describeCall", () => {
    it("names the queried accession", () => {
        expect(alphafoldPredictionTool.describeCall!({ uniprotAccession: "P38398" })).toBe("P38398");
    });
});

describe("alphafold_prediction — the display path", () => {
    // The description is the whole of what the agent knows about the tool. Without the pointer it
    // reaches for a sandbox download to show a structure, which lands a binary the chat cannot render.
    it("names show_user(kind: structure) as the way to show the model, and keeps files out of the conversation", () => {
        expect(alphafoldPredictionTool.description).toContain("show_user");
        expect(alphafoldPredictionTool.description).toContain('kind: "structure"');
        expect(alphafoldPredictionTool.description).toContain("do not expect the file contents here");
    });
});
