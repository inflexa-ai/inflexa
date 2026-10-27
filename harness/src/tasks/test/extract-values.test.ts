import { describe, expect, it } from "bun:test";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { SpawnSession } from "../../auth/types.js";
import { parseJsonAs } from "../../lib/parse-json.js";
import { isUnknownArray } from "../../lib/unknown-array.js";
import type { ExtractionRequest } from "../../report-model/production-resolver.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecRequest, ExecResult, SandboxRef, SandboxSpec } from "../../sandbox/types.js";
import { EXTRACTION_INPUT_ENV, EXTRACTION_SCRIPT } from "../extract-values-script.js";
import { buildExtractionExec, createExtractionArm, extractionArtifactsFromResult, parseExtractionOutput, runExtraction } from "../extract-values.js";

// The decidable parts are lifted out: the exec command, the output parse, and the arm mapping. These tests
// pin each part without a container and without DBOS. The pass runs over a stubbed sandbox client.

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
        const matches = EXTRACTION_SCRIPT.split("keep_default_na=False)").length - 1;
        expect(matches).toBe(2);
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
        const body = buildExtractionExec("an-1", [
            { path: "data/x.tsv", hash: "h1", format: "tsv" },
            { path: "/an-1/data/y.parquet", hash: "h2", format: "parquet" },
            { path: "data/z.csv", hash: "h3", format: "csv" },
        ]);
        expect(body.command).toEqual(["python3", "-c", EXTRACTION_SCRIPT]);
        expect(body.cwd).toBe("/an-1");

        // The request list rides in one environment variable. Each request carries its pinned hash, thus
        // the script can refuse a file that drifted from the pin.
        const execEnv = body.env;
        if (execEnv === undefined) throw new Error("the exec carries no environment");
        const parsed = parseJsonAs(execEnv[EXTRACTION_INPUT_ENV] ?? "", z.json());
        if (!isUnknownArray(parsed)) throw new Error("the exec carries no request list");
        expect(parsed).toEqual([
            { path: "data/x.tsv", format: "tsv", hash: "h1" },
            { path: "/an-1/data/y.parquet", format: "parquet", hash: "h2" },
            { path: "data/z.csv", format: "csv", hash: "h3" },
        ]);
    });

    it("carries the format of the request, and it reads no format from the extension", () => {
        // The host decides the format one time. A request whose format disagrees with the extension proves
        // that this arm repeats no mapping of its own.
        const body = buildExtractionExec("an-1", [{ path: "data/x.csv", hash: "h1", format: "tsv" }]);

        const execEnv = body.env;
        if (execEnv === undefined) throw new Error("the exec carries no environment");
        const parsed = parseJsonAs(execEnv[EXTRACTION_INPUT_ENV] ?? "", z.json());
        if (!isUnknownArray(parsed)) throw new Error("the exec carries no request list");
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
        const arm = createExtractionArm((requests) => {
            received = requests;
            return Promise.resolve(
                ok({
                    "data/a.csv": { rows: [{ gene: "TP53", value: 4 }] },
                    "data/b.parquet": { error: { type: "read-fault", message: "boom" } },
                }),
            );
        });

        const requests: ExtractionRequest[] = [
            { path: "data/a.csv", hash: "h1", format: "csv" },
            { path: "data/b.parquet", hash: "h2", format: "parquet" },
        ];
        const map = (await arm.extract(requests))._unsafeUnwrap();

        // One extract call makes one run with every request in it.
        expect(received).toEqual(requests);
        expect(map.get("data/a.csv")).toEqual({ rows: [{ gene: "TP53", value: 4 }] });
        expect(map.has("data/b.parquet")).toBe(false);
    });

    it("gives the suspension of the pass as its err", async () => {
        const arm = createExtractionArm(() => Promise.resolve(err({ kind: "suspended" as const, reason: "quota_exhausted" })));
        expect((await arm.extract([{ path: "data/a.csv", hash: "h1", format: "csv" }]))._unsafeUnwrapErr()).toEqual({
            kind: "suspended",
            reason: "quota_exhausted",
        });
    });

    it("rejects when the runner faults", async () => {
        const arm = createExtractionArm(() => {
            return Promise.reject(new Error("the workflow faulted"));
        });
        await expect(arm.extract([{ path: "data/a.csv", hash: "h1", format: "csv" }])).rejects.toThrow("the workflow faulted");
    });
});

describe("runExtraction", () => {
    const caller = { analysisId: "an-1", identity: { user: "u-1" }, auth: makeLocalAuth() };
    const requests: ExtractionRequest[] = [{ path: "data/a.csv", hash: "h1", format: "csv" }];

    /** A stubbed sandbox client. It records the spawn and the exec, and it answers with one script output. */
    function stubClient(args: { readonly stdout?: string; readonly refuse?: boolean }) {
        const spawns: Array<{ session: SpawnSession; spec: SandboxSpec }> = [];
        const execs: ExecRequest[] = [];
        const teardowns: string[] = [];
        const ref: SandboxRef = { sandboxId: "sbx-extract-1", host: "127.0.0.1", port: 8765, backend: "docker" };
        const client = {
            toolchainSource: "store" as const,
            createSandbox(session: SpawnSession, spec: SandboxSpec) {
                if (args.refuse === true) return errAsync({ type: "labels_refused" as const, op: "createSandbox", reason: "quota_exhausted", suspend: true });
                spawns.push({ session, spec });
                return okAsync(ref);
            },
            exec(_ref: SandboxRef, request: ExecRequest): Promise<ExecResult> {
                execs.push(request);
                return Promise.resolve(execResult({ stdout: args.stdout ?? "{}" }));
            },
            teardown(handle: SandboxRef): Promise<void> {
                teardowns.push(handle.sandboxId);
                return Promise.resolve();
            },
            isAlive: () => Promise.resolve({ alive: true, oomKilled: false }),
            isAliveById: () => Promise.resolve({ alive: true, oomKilled: false }),
            teardownById: () => Promise.resolve(),
            listManagedSandboxes: () => Promise.resolve([]),
        } satisfies SandboxClient;
        return { client, spawns, execs, teardowns };
    }

    it("reads every request in one read-only container under the caller, and removes the container", async () => {
        const stub = stubClient({ stdout: JSON.stringify({ "data/a.csv": { rows: [{ gene: "TP53", value: 4 }] } }) });

        const result = (await runExtraction({ sandboxClient: stub.client }, caller, requests))._unsafeUnwrap();

        expect(result).toEqual({ "data/a.csv": { rows: [{ gene: "TP53", value: 4 }] } });
        expect(stub.execs).toEqual([buildExtractionExec("an-1", requests)]);
        expect(stub.teardowns).toEqual(["sbx-extract-1"]);
        const spawn = stub.spawns[0];
        if (spawn === undefined) throw new Error("the pass made no container");
        expect(spawn.spec).toMatchObject({ readOnly: true, resources: { cpu: 2, memoryGb: 8 } });
        // The pass mints no mandate: the container runs under the identity and the auth of the caller, with
        // a frame that names no run of the analysis.
        expect(spawn.session.identity).toEqual({ user: "u-1" });
        expect(spawn.session.auth).toEqual(caller.auth);
        expect(spawn.session.runFrame).toEqual({ runId: "extract-values", stepId: "extract" });
    });

    it("gives a suspending refusal of the spawn as its err, and it runs no exec", async () => {
        const stub = stubClient({ refuse: true });

        const result = await runExtraction({ sandboxClient: stub.client }, caller, requests);

        expect(result._unsafeUnwrapErr()).toEqual({ kind: "suspended", reason: "quota_exhausted" });
        expect(stub.execs).toEqual([]);
    });

    it("rejects when the script fails, and it still removes the container", async () => {
        const stub = stubClient({ stdout: "not json" });

        await expect(runExtraction({ sandboxClient: stub.client }, caller, requests)).rejects.toThrow("did not emit valid JSON");
        expect(stub.teardowns).toEqual(["sbx-extract-1"]);
    });
});
