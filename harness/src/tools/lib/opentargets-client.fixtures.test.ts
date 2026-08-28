import { expect } from "bun:test";
import { z } from "zod";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { mapBaselineExpression, TargetAssociationsDataSchema, TargetExpressionDataSchema, TargetSafetyDataSchema } from "./opentargets-client.js";

// Each fixture holds the whole GraphQL response. Thus each schema under test is
// the `data` schema inside the same envelope that `gqlFetch` validates.
const TargetAssociationsResponseSchema = z.object({ data: TargetAssociationsDataSchema });
const TargetSafetyResponseSchema = z.object({ data: TargetSafetyDataSchema });
const TargetExpressionResponseSchema = z.object({ data: TargetExpressionDataSchema });

runFixtureSuite("Open Targets golden fixtures", [
    fixtureCase({
        name: "TargetAssociationsDataSchema",
        provider: "opentargets",
        fixture: "target_TP53.json",
        drift: "target_TP53.drift.json",
        schema: TargetAssociationsResponseSchema,
        assertOutput: (res) => {
            expect(res.data.target?.approvedSymbol).toBe("TP53");
            expect(res.data.target?.tractability?.length).toBeGreaterThan(0);
            expect(res.data.associations?.associatedDiseases?.rows?.[0]?.disease.name).toBe("Li-Fraumeni syndrome");
        },
    }),
    fixtureCase({
        name: "TargetAssociationsDataSchema, an id that Open Targets does not hold",
        provider: "opentargets",
        fixture: "target_invalid.json",
        drift: "target_TP53.drift.json",
        schema: TargetAssociationsResponseSchema,
        assertOutput: (res) => {
            // The SDL marks `Query.target` nullable, thus the explicit null is
            // data. `searchTargetAssociations` reads it and returns `null`, which
            // is the not-found answer, and never a thrown error.
            expect(res.data.target).toBeNull();
            expect(res.data.associations).toBeNull();
        },
    }),
    fixtureCase({
        name: "TargetSafetyDataSchema",
        provider: "opentargets",
        fixture: "safety_TP53.json",
        drift: "safety_TP53.drift.json",
        schema: TargetSafetyResponseSchema,
        assertOutput: (res) => {
            const liabilities = res.data.target?.safetyLiabilities ?? [];
            expect(liabilities.length).toBe(4);
            // A biosample row carries an explicit null label, and the schema admits it.
            expect(liabilities.some((liability) => (liability.biosamples ?? []).some((biosample) => biosample.tissueLabel === null))).toBe(true);
        },
    }),
    fixtureCase({
        name: "TargetExpressionDataSchema",
        provider: "opentargets",
        fixture: "baseline_expression_TP53.json",
        drift: "baseline_expression_TP53.drift.json",
        schema: TargetExpressionResponseSchema,
        assertOutput: (res) => {
            const rows = res.data.target?.baselineExpression.rows ?? [];
            expect(rows.length).toBe(6);
            // Two rows measure a cell type alone and carry no tissue biosample,
            // thus the mapping drops them.
            const entries = mapBaselineExpression(res.data);
            expect(entries.length).toBe(4);
            expect(entries[0]).toEqual({
                tissueId: "UBERON_0000007",
                tissueLabel: "pituitary gland",
                organSystem: "brain",
                datasourceId: "gtex",
                rna: { value: 8.4579, unit: "TPM" },
                protein: null,
            });
            // The rows of one target come from more than one datasource, and the
            // units differ between them.
            expect(new Set(entries.map((entry) => entry.datasourceId))).toEqual(new Set(["gtex", "tabula_sapiens"]));
        },
    }),
]);
