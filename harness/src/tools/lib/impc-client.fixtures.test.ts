/**
 * Golden fixtures of the IMPC Solr API.
 *
 * The client declares its wire schema privately, thus this file drives the
 * exported readers over the same payloads. The audit found no field mismatch on
 * this provider, and these fixtures pin that state: `p_value` is a JSON float,
 * `sex` is a string and never an array, and `mgi_accession_id` is served by the
 * gene core alone.
 */

import { describe, expect, it } from "bun:test";

import { readFixture } from "./__fixtures__/fixture-runner.js";
import { buildViabilityCalls, derivedViability, parsePhenotypeResponse } from "./impc-client.js";

describe("IMPC golden fixtures", () => {
    it("resolves the mouse marker of a human symbol", () => {
        const body = readFixture("impc", "gene-select-TP53.json") as {
            response: { numFound: number; docs: Record<string, unknown>[] };
        };
        expect(body.response.numFound).toBe(1);
        expect(body.response.docs[0]!.marker_symbol).toBe("Trp53");
        expect(body.response.docs[0]!.mgi_accession_id).toBe("MGI:98834");
    });

    it("reads the phenotype profile of the genotype-phenotype core", () => {
        const profile = parsePhenotypeResponse(readFixture("impc", "gp-select-Trp53-rows5.json"));

        expect(profile.phenotypeCount).toBeGreaterThan(0);
        expect(profile.mpTerms[0]!.id).toStartWith("MP:");
        expect(typeof profile.mpTerms[0]!.bestPValue).toBe("number");
        expect(profile.organSystems.length).toBeGreaterThan(0);
    });

    it("serves p_value as a float and sex as a string", () => {
        const body = readFixture("impc", "gp-select-Trp53-rows5.json") as {
            response: { docs: Record<string, unknown>[] };
        };
        for (const doc of body.response.docs) {
            if ("p_value" in doc) expect(typeof doc.p_value).toBe("number");
            if ("sex" in doc) expect(typeof doc.sex).toBe("string");
            // The genotype-phenotype core serves no MGI accession.
            expect("mgi_accession_id" in doc).toBe(false);
        }
    });

    it("drops a phenotype row whose p_value drifted to a string", () => {
        const profile = parsePhenotypeResponse(readFixture("impc", "gp-select-Trp53-rows5.drift.json"));
        const drifted = profile.mpTerms.find((term) => term.id === "MP:0001289");
        expect(drifted?.bestPValue).toBeNull();
    });

    it("reads the viability calls of the primary screen", () => {
        const calls = buildViabilityCalls(readFixture("impc", "gp-viability-Trp53.json"), { response: { docs: [] } });
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]!.parameterStableId).toStartWith("IMPC_VIA_");
        expect(derivedViability(calls)).not.toBeNull();
    });
});
