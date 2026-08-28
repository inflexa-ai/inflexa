/**
 * Golden fixtures of the Bgee expression API.
 *
 * The client declares its wire schema privately, thus this file drives the
 * exported reader `parseExpressionResponse` over the same payload. The reader is
 * what every caller sees, and it carries the observed absence encoding of the
 * provider: an absent `cellType` is an omitted key, and `expressionScore` is
 * always a JSON string.
 */

import { describe, expect, it } from "bun:test";

import { readFixture } from "./__fixtures__/fixture-runner.js";
import { bucketRank, parseExpressionResponse } from "./bgee-client.js";

describe("Bgee golden fixtures", () => {
    it("reads the observed wire shape of an expression call", () => {
        const rows = parseExpressionResponse(readFixture("bgee", "expr-TP53-human.json"));

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.tissue !== "")).toBe(true);
        expect(rows.every((row) => row.expressionState === "expressed")).toBe(true);
        expect(rows.some((row) => row.cellType !== null)).toBe(true);
        expect(rows.some((row) => row.cellType === null)).toBe(true);
        // The provider serializes the score as a JSON string, thus the reader
        // must give a number and never the raw string.
        expect(rows.every((row) => row.expressionScore === null || typeof row.expressionScore === "number")).toBe(true);
    });

    it("serves the expression score as a string on the wire", () => {
        const body = readFixture("bgee", "expr-TP53-human.json") as {
            data: { calls: { expressionScore?: { expressionScore?: unknown } }[] };
        };
        expect(typeof body.data.calls[0]!.expressionScore!.expressionScore).toBe("string");
    });

    it("gives a null score when the drift twin breaks the score type", () => {
        const rows = parseExpressionResponse(readFixture("bgee", "expr-TP53-human.drift.json"));
        expect(rows[0]!.expressionScore).toBeNull();
    });

    it("buckets a score into the declared rank", () => {
        expect(bucketRank("expressed", 95.11)).toBe("high");
        expect(bucketRank("expressed", 30)).toBe("medium");
        expect(bucketRank("expressed", 5)).toBe("low");
        expect(bucketRank("expressed", null)).toBe("low");
        expect(bucketRank("not expressed", 95.11)).toBe("absent");
    });
});
