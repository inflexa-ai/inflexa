import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "../lib/__fixtures__/fixture-runner.js";
import { GoAnnotationResponseSchema, GoTermResponseSchema } from "./lookup-annotation.js";

runFixtureSuite("QuickGO golden fixtures", [
    fixtureCase({
        name: "GoTermResponseSchema",
        provider: "quickgo",
        fixture: "term_GO_0008150.json",
        drift: "term_GO_0008150.drift.json",
        schema: GoTermResponseSchema,
        assertOutput: (terms) => {
            expect(terms.length).toBe(1);
            expect(terms[0]?.id).toBe("GO:0008150");
            expect(terms[0]?.name).toBe("biological_process");
            expect(terms[0]?.definition).not.toBe(undefined);
        },
    }),
    fixtureCase({
        name: "GoAnnotationResponseSchema, with includeFields=goName",
        provider: "quickgo",
        fixture: "annotation_P04637_includeFields_goName.json",
        drift: "annotation_P04637_includeFields_goName.drift.json",
        schema: GoAnnotationResponseSchema,
        assertOutput: (annotations) => {
            expect(annotations.length).toBeGreaterThan(0);
            // The request names `goName`, thus each row carries the real label.
            for (const annotation of annotations) {
                expect(annotation.goName).not.toBe("");
                expect(annotation.goId).toMatch(/^GO:\d{7}$/);
            }
        },
    }),
    fixtureCase({
        name: "GoAnnotationResponseSchema, without includeFields",
        provider: "quickgo",
        fixture: "annotation_P04637.json",
        drift: "annotation_P04637_includeFields_goName.drift.json",
        schema: GoAnnotationResponseSchema,
        assertOutput: (annotations) => {
            expect(annotations.length).toBeGreaterThan(0);
            // A request that does not name `goName` gets an explicit null on each
            // row. The nullable modifier admits it, and the mapping gives the
            // empty string. A bare `.optional()` rejects the null under zod 4,
            // and every GO annotation call then throws.
            for (const annotation of annotations) {
                expect(annotation.goName).toBe("");
                expect(annotation.geneProductId).toBe("UniProtKB:P04637");
            }
        },
    }),
]);
