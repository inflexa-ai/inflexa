import { describe, expect, it } from "bun:test";

import type { ExtractionRequest } from "../report-model/production-resolver.js";
import type { ExecResult } from "../sandbox/types.js";
import { EXTRACTION_INPUT_ENV, EXTRACTION_SCRIPT } from "./extract-values-script.js";
import { buildExtractionExec, createExtractionArm, extractionArtifactsFromResult, parseExtractionOutput } from "./extract-values.js";

// The workflow body needs a launched durability engine and a sandbox, thus a unit test does not reach it.
// The decidable parts are lifted out: the exec command, the output parse, and the arm mapping. These tests
// pin each part without a container and without DBOS.

/** A complete exec result. Each test overrides only the fields that it asserts. */
function execResult(over: Partial<ExecResult>): ExecResult {
    return {
        execId: "exec-1",
        exitCode: 0,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        ...over,
    };
}

describe("the extraction script", () => {
    it("carries the JSON protocol markers", () => {
        // A static check of the markers is enough. The script runs in the container, not in the test.
        expect(EXTRACTION_SCRIPT).toContain("import pandas");
        expect(EXTRACTION_SCRIPT).toContain(EXTRACTION_INPUT_ENV);
        expect(EXTRACTION_SCRIPT).toContain("json.loads");
        expect(EXTRACTION_SCRIPT).toContain("json.dump");
        expect(EXTRACTION_SCRIPT).toContain('"rows"');
        expect(EXTRACTION_SCRIPT).toContain('"error"');
        expect(EXTRACTION_SCRIPT).toContain("read_parquet");
    });

    it("hashes the file before the read and refuses a drifted file", () => {
        // The script streams a sha256 in the host "sha256:<hex>" form, and it refuses a mismatch as a
        // typed per-path error. A static check of the markers is enough.
        expect(EXTRACTION_SCRIPT).toContain("hashlib");
        expect(EXTRACTION_SCRIPT).toContain("hash-mismatch");
    });

    it("keeps a literal NA cell as text for each pandas text read", () => {
        // keep_default_na=False keeps a literal cell such as "NA" or an empty string as its text, thus a
        // text cell survives the extraction the same as the host parser keeps it. The two text reads each
        // set the flag, thus the regex anchors on the closing paren of the read call.
        const matches = EXTRACTION_SCRIPT.match(/keep_default_na=False\)/g);
        expect(matches).toHaveLength(2);
    });
});

describe("buildExtractionExec", () => {
    it("runs the script through python -c under the analysis mount", () => {
        const body = buildExtractionExec(
            "an-1",
            [
                { path: "data/x.tsv", hash: "h1" },
                { path: "/an-1/data/y.parquet", hash: "h2" },
                { path: "data/z.dat", hash: "h3" },
            ],
            "exec-9",
        );
        expect(body.command).toEqual(["python3", "-c", EXTRACTION_SCRIPT]);
        expect(body.execId).toBe("exec-9");
        expect(body.cwd).toBe("/an-1");

        // The request list rides in one environment variable. The format derives from the extension. An
        // unknown extension reads as csv, which is the general reader. Each request carries its pinned
        // hash, thus the script can refuse a file that drifted from the pin.
        const parsed = JSON.parse(body.env![EXTRACTION_INPUT_ENV]);
        expect(parsed).toEqual([
            { path: "data/x.tsv", format: "tsv", hash: "h1" },
            { path: "/an-1/data/y.parquet", format: "parquet", hash: "h2" },
            { path: "data/z.dat", format: "csv", hash: "h3" },
        ]);
    });
});

describe("parseExtractionOutput", () => {
    it("parses a map with a rows entry and a per-path error entry", () => {
        const stdout = JSON.stringify({
            "data/a.csv": { rows: [{ gene: "TP53", value: 4 }] },
            "data/b.parquet": { error: { type: "read-fault", message: "the file did not open" } },
        });
        const parsed = parseExtractionOutput(execResult({ stdout }));
        expect(parsed["data/a.csv"]).toEqual({ rows: [{ gene: "TP53", value: 4 }] });
        expect(parsed["data/b.parquet"]).toEqual({ error: { type: "read-fault", message: "the file did not open" } });
    });

    it("throws on a non-zero exit", () => {
        expect(() => parseExtractionOutput(execResult({ exitCode: 1, stdout: "" }))).toThrow();
    });

    it("throws on output that is not valid JSON", () => {
        expect(() => parseExtractionOutput(execResult({ stdout: "not json" }))).toThrow();
    });

    it("throws on a timeout", () => {
        expect(() => parseExtractionOutput(execResult({ timedOut: true }))).toThrow();
    });

    it("throws on a synthetic sandbox failure", () => {
        expect(() => parseExtractionOutput(execResult({ syntheticFailure: { reason: "sandbox-dead" } }))).toThrow();
    });
});

describe("extractionArtifactsFromResult", () => {
    it("keeps a rows entry and drops an error entry", () => {
        const map = extractionArtifactsFromResult({
            "data/a.csv": { rows: [{ gene: "TP53", value: 4 }] },
            "data/b.parquet": { error: { type: "read-fault", message: "boom" } },
        });
        expect(map.get("data/a.csv")).toEqual({ rows: [{ gene: "TP53", value: 4 }] });
        expect(map.has("data/b.parquet")).toBe(false);
    });
});

describe("createExtractionArm", () => {
    it("forwards every request to the runner and maps the outcome", async () => {
        let received: readonly ExtractionRequest[] | undefined;
        const arm = createExtractionArm(async (requests) => {
            received = requests;
            return {
                "data/a.csv": { rows: [{ gene: "TP53", value: 4 }] },
                "data/b.parquet": { error: { type: "read-fault", message: "boom" } },
            };
        });

        const requests: ExtractionRequest[] = [
            { path: "data/a.csv", hash: "h1" },
            { path: "data/b.parquet", hash: "h2" },
        ];
        const map = await arm.extract(requests);

        // One extract call makes one run with every request in it.
        expect(received).toEqual(requests);
        expect(map.get("data/a.csv")).toEqual({ rows: [{ gene: "TP53", value: 4 }] });
        expect(map.has("data/b.parquet")).toBe(false);
    });

    it("rejects when the runner faults", async () => {
        const arm = createExtractionArm(async () => {
            throw new Error("the workflow faulted");
        });
        await expect(arm.extract([{ path: "data/a.csv", hash: "h1" }])).rejects.toThrow("the workflow faulted");
    });
});
