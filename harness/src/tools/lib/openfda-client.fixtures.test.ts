import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { OpenFdaLabelResponseSchema } from "./openfda-client.js";

runFixtureSuite("openfda golden fixtures", [
    fixtureCase({
        name: "OpenFdaLabelResponseSchema — a label with a REMS program",
        provider: "openfda",
        fixture: "label-lenalidomide-rems.json",
        drift: "label-lenalidomide-rems.drift.json",
        schema: OpenFdaLabelResponseSchema,
        assertOutput: (body) => {
            const label = body.results![0]!;
            expect(label.genericName).toBe("LENALIDOMIDE");
            expect(label.applicationNumber).toBe("ANDA201452");
            expect(label.effectiveTime).toBe("20260527");
            expect(label.boxedWarning).toContain("REMS");
            expect(label.warningsAndCautions).not.toBeNull();
            expect(label.hasRems).toBe(true);
            expect(label.sourceUrl).toContain("dailymed.nlm.nih.gov");
        },
    }),
    fixtureCase({
        name: "OpenFdaLabelResponseSchema — a label with an empty openfda block",
        provider: "openfda",
        fixture: "label-missing-openfda.json",
        drift: "label-missing-openfda.drift.json",
        schema: OpenFdaLabelResponseSchema,
        assertOutput: (body) => {
            const label = body.results![0]!;
            // An unapproved product carries `openfda: {}`, and it omits the
            // boxed-warning key. Both are normal, thus the schema parses the record.
            expect(label.brandName).toBeNull();
            expect(label.genericName).toBeNull();
            expect(label.applicationNumber).toBeNull();
            expect(label.boxedWarning).toBeNull();
            // No section names REMS, thus the row reports none.
            expect(label.hasRems).toBe(false);
            expect(label.warningsAndCautions).not.toBeNull();
        },
    }),
]);
