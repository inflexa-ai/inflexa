import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { PubChemPropertyResponseSchema } from "./pubchem-client.js";

runFixtureSuite("pubchem golden fixtures — the enrichment client", [
    fixtureCase({
        name: "PubChemPropertyResponseSchema — the classifier fields",
        provider: "pubchem",
        fixture: "client-property-cid-2244.json",
        drift: "client-property-cid-2244.drift.json",
        schema: PubChemPropertyResponseSchema,
        assertOutput: (response) => {
            const aspirin = response.PropertyTable?.Properties?.[0];
            expect(aspirin?.CID).toBe(2244);
            // The live wire key is `ConnectivitySMILES`. A `z.unknown()` field would
            // reject the row here, because zod 4 makes it required.
            expect(aspirin?.ConnectivitySMILES).toBe("CC(=O)OC1=CC=CC=C1C(=O)O");
            expect(aspirin?.MolecularWeight).toBe(180.16);
            expect(aspirin?.InChIKey).toBe("BSYNRYMUTXBXSQ-UHFFFAOYSA-N");
            expect(aspirin?.HBondDonorCount).toBe(1);
        },
    }),
]);
