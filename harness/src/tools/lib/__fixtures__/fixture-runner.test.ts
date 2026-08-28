import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { zWireNumber } from "../api-utils.js";
import { fixtureCase, readFixture, runFixtureSuite } from "./fixture-runner.js";

// The self-test schema stands in for a provider client. It carries the three
// modifier shapes that a real table exercises: a strict field, an explicit null,
// and a number that the wire serializes as a string.
const SelfTestRowSchema = z.object({
    id: z.number(),
    label: z.string().nullable(),
    score: zWireNumber.optional(),
});

runFixtureSuite("fixture-runner self-test", [
    fixtureCase({
        name: "SelfTestRowSchema",
        provider: "_selftest",
        fixture: "row.json",
        drift: "row.drift.json",
        schema: SelfTestRowSchema,
        assertOutput: (row) => {
            expect(row.id).toBe(12);
            expect(row.label).toBeNull();
            expect(row.score).toBe(0.75);
        },
    }),
]);

describe("the self-test twin", () => {
    it("breaks one type against the positive fixture", () => {
        // A twin that only copies the positive fixture proves nothing. The runner
        // guards the schema only while the twin holds a real type break.
        const positive = readFixture("_selftest", "row.json") as { id: unknown };
        const drift = readFixture("_selftest", "row.drift.json") as { id: unknown };

        expect(typeof positive.id).toBe("number");
        expect(typeof drift.id).toBe("string");
    });
});
