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

    it("reads a JSON file by the strict host shape, and it infers no table", () => {
        // The host reads a JSON table as an array of flat objects. The script obeys the same shape, thus a
        // shape that the host refuses comes back as a typed refusal. A pandas inference pass would give
        // back a different table for the same bytes.
        expect(EXTRACTION_SCRIPT).not.toContain("read_json");
        expect(EXTRACTION_SCRIPT).toContain("the JSON top-level value is not an array");
        expect(EXTRACTION_SCRIPT).toContain("a JSON array item is not an object");
        expect(EXTRACTION_SCRIPT).toContain("a JSON cell holds a nested value");
    });

    it("refuses a request that names no format", () => {
        // The host decides the format for both arms. The script derives no reader from the extension, thus
        // a request with no format is a protocol fault and never a comma-delimited guess.
        expect(EXTRACTION_SCRIPT).toContain("the request names no supported format");
        expect(EXTRACTION_SCRIPT).toContain('request.get("format")');
    });
});

describe("buildExtractionExec", () => {
    it("runs the script through python -c under the analysis mount", () => {
        const body = buildExtractionExec(
            "an-1",
            [
                { path: "data/x.tsv", hash: "h1", format: "tsv" },
                { path: "/an-1/data/y.parquet", hash: "h2", format: "parquet" },
                { path: "data/z.csv", hash: "h3", format: "csv" },
            ],
            "exec-9",
        );
        expect(body.command).toEqual(["python3", "-c", EXTRACTION_SCRIPT]);
        expect(body.execId).toBe("exec-9");
        expect(body.cwd).toBe("/an-1");

        // The request list rides in one environment variable. Each request carries its pinned hash, thus
        // the script can refuse a file that drifted from the pin.
        const parsed = JSON.parse(body.env![EXTRACTION_INPUT_ENV]);
        expect(parsed).toEqual([
            { path: "data/x.tsv", format: "tsv", hash: "h1" },
            { path: "/an-1/data/y.parquet", format: "parquet", hash: "h2" },
            { path: "data/z.csv", format: "csv", hash: "h3" },
        ]);
    });

    it("carries the format of the request, and it reads no format from the extension", () => {
        // The host decides the format one time. A request whose format disagrees with the extension proves
        // that this arm repeats no mapping of its own.
        const body = buildExtractionExec("an-1", [{ path: "data/x.csv", hash: "h1", format: "tsv" }], "exec-10");

        const parsed = JSON.parse(body.env![EXTRACTION_INPUT_ENV]);
        expect(parsed).toEqual([{ path: "data/x.csv", format: "tsv", hash: "h1" }]);
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
            { path: "data/a.csv", hash: "h1", format: "csv" },
            { path: "data/b.parquet", hash: "h2", format: "parquet" },
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
        await expect(arm.extract([{ path: "data/a.csv", hash: "h1", format: "csv" }])).rejects.toThrow("the workflow faulted");
    });
});
