import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "../__fixtures__/fixture-runner.js";
import { InterProEntryPageSchema } from "../interpro-client.js";

runFixtureSuite("interpro golden fixtures", [
    fixtureCase({
        name: "InterProEntryPageSchema — the entries of one protein, with the explicit nulls of InterPro",
        provider: "interpro",
        fixture: "entries-P38398.json",
        drift: "entries-P38398.drift.json",
        schema: InterProEntryPageSchema,
        assertOutput: (page) => {
            expect(page.count).toBe(9);
            expect(page.results).toHaveLength(9);
            const byAccession = new Map(page.results.map((entry) => [entry.accession, entry]));
            // The two BRCT repeats of the C terminus are two ranges of one entry, in sequence order.
            expect(byAccession.get("IPR001357")).toEqual({
                accession: "IPR001357",
                name: "BRCT domain",
                type: "domain",
                memberDatabases: {
                    pfam: {
                        PF12738: "twin BRCT domain",
                        PF16770: "Regulator of Ty1 transposition protein 107 BRCT domain",
                        PF16589: "BRCT domain",
                        PF00533: "BRCA1 C Terminus (BRCT) domain",
                    },
                    profile: { PS50172: "BRCT domain profile" },
                    smart: { SM00292: "breast cancer carboxy-terminal domain" },
                },
                locations: [
                    { start: 1642, end: 1736 },
                    { start: 1756, end: 1855 },
                ],
                locationCount: 2,
            });
            expect(byAccession.get("IPR001841")?.type).toBe("domain");
            expect(byAccession.get("IPR011364")?.type).toBe("family");
            expect(byAccession.get("IPR036420")?.type).toBe("homologous_superfamily");
            expect(byAccession.get("IPR017907")?.type).toBe("conserved_site");
            for (const entry of page.results) {
                expect(entry.locations.length).toBeGreaterThan(0);
                expect(entry.locations.every((range) => range.start <= range.end)).toBe(true);
            }
        },
    }),
]);
