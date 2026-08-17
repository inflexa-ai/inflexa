/**
 * The tests of the content-URL contract.
 *
 * The `res` claim formulas are locked to the shared test vector at
 * `src/__tests__/fixtures/preview-res.json`. The storage backend asserts its Go mirrors against a copy of
 * the same fixture, thus a drift on either side fails one CI and code review catches the other copy.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildPreviewUrl, buildReportSessionUrl, previewResourceId, reportSessionResourceId } from "./content-url.js";

interface PreviewVector {
    analysisId: string;
    previewId: string;
    expectedRes: string;
}

interface ReportSessionVector {
    analysisId: string;
    threadId: string;
    expectedRes: string;
}

const fixture = JSON.parse(readFileSync(new URL("../__tests__/fixtures/preview-res.json", import.meta.url), "utf8")) as {
    vectors: PreviewVector[];
    reportSessionVectors: ReportSessionVector[];
};

describe("previewResourceId", () => {
    test("matches every vector of the shared fixture", () => {
        expect(fixture.vectors.length).toBeGreaterThanOrEqual(4);
        for (const vector of fixture.vectors) {
            expect(previewResourceId(vector.analysisId, vector.previewId)).toBe(vector.expectedRes);
        }
    });

    test("gives no leading and no trailing slash", () => {
        for (const vector of fixture.vectors) {
            const res = previewResourceId(vector.analysisId, vector.previewId);
            expect(res.startsWith("previews/")).toBe(true);
            expect(res.startsWith("/")).toBe(false);
            expect(res.endsWith("/")).toBe(false);
        }
    });
});

describe("reportSessionResourceId", () => {
    test("matches every vector of the shared fixture", () => {
        expect(fixture.reportSessionVectors.length).toBeGreaterThanOrEqual(2);
        for (const vector of fixture.reportSessionVectors) {
            expect(reportSessionResourceId(vector.analysisId, vector.threadId)).toBe(vector.expectedRes);
        }
    });

    test("gives no leading and no trailing slash", () => {
        for (const vector of fixture.reportSessionVectors) {
            const res = reportSessionResourceId(vector.analysisId, vector.threadId);
            expect(res.startsWith("report-sessions/")).toBe(true);
            expect(res.startsWith("/")).toBe(false);
            expect(res.endsWith("/")).toBe(false);
        }
    });
});

describe("buildPreviewUrl", () => {
    test("composes the base, the res, the path, and the encoded token", () => {
        const url = buildPreviewUrl("https://content.test/", "analysis-001", "prv-abc", "/v1/index.html", "tok/en+1");
        expect(url).toBe("https://content.test/previews/analysis-001/prv-abc/v1/index.html?t=tok%2Fen%2B1");
    });
});

describe("buildReportSessionUrl", () => {
    test("composes the base, the res, the path, and the encoded token", () => {
        const url = buildReportSessionUrl("https://content.test/", "a1", "t9", "/index.html", "tok/en+1");
        expect(url).toBe("https://content.test/report-sessions/a1/t9/index.html?t=tok%2Fen%2B1");
    });

    test("agrees with the res formula on every fixture vector", () => {
        for (const vector of fixture.reportSessionVectors) {
            const url = buildReportSessionUrl("https://content.test", vector.analysisId, vector.threadId, "index.html", "tok");
            expect(url).toBe(`https://content.test/${vector.expectedRes}/index.html?t=tok`);
        }
    });
});
