/**
 * The tests of the content-URL contract.
 *
 * The `res` claim formula is locked to the shared test vector at
 * `src/__tests__/fixtures/report-session-res.json`. The
 * fixture is a byte-identical copy of the storage backend's `kernel/contenttoken/testdata` file, and both
 * sides assert against every vector. Thus a drift on either side fails one CI, and code review catches the
 * other copy.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildReportSessionUrl, reportSessionResourceId } from "./content-url.js";

interface ReportSessionVector {
    analysisId: string;
    threadId: string;
    expectedRes: string;
}

function readFixture<T>(name: string): { vectors: T[] } {
    return JSON.parse(readFileSync(new URL(`../__tests__/fixtures/${name}`, import.meta.url), "utf8")) as { vectors: T[] };
}

const reportSessionFixture = readFixture<ReportSessionVector>("report-session-res.json");

describe("reportSessionResourceId", () => {
    test("matches every vector of the shared fixture", () => {
        expect(reportSessionFixture.vectors.length).toBeGreaterThanOrEqual(2);
        for (const vector of reportSessionFixture.vectors) {
            expect(reportSessionResourceId(vector.analysisId, vector.threadId)).toBe(vector.expectedRes);
        }
    });

    test("gives no leading and no trailing slash", () => {
        for (const vector of reportSessionFixture.vectors) {
            const res = reportSessionResourceId(vector.analysisId, vector.threadId);
            expect(res.startsWith("report-sessions/")).toBe(true);
            expect(res.startsWith("/")).toBe(false);
            expect(res.endsWith("/")).toBe(false);
        }
    });
});

describe("buildReportSessionUrl", () => {
    test("composes the base, the res, the path, and the encoded token", () => {
        const url = buildReportSessionUrl("https://content.test/", "a1", "t9", "/index.html", "tok/en+1");
        expect(url).toBe("https://content.test/report-sessions/a1/t9/index.html?t=tok%2Fen%2B1");
    });

    test("agrees with the res formula on every fixture vector", () => {
        for (const vector of reportSessionFixture.vectors) {
            const url = buildReportSessionUrl("https://content.test", vector.analysisId, vector.threadId, "index.html", "tok");
            expect(url).toBe(`https://content.test/${vector.expectedRes}/index.html?t=tok`);
        }
    });
});
