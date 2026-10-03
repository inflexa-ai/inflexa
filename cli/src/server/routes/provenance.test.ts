import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProvEvent, PROV_UNIFY_OPTIONS, type ProvAttestation } from "@inflexa-ai/prov-kernel";
import { Hono } from "hono";

import type { ExportProvenanceResult, LineageView } from "../../api/provenance.ts";
import { insertAnalysis, insertAnchor, updateAnalysisProvenance } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import { defaultOutputSubdir, invalidateWorkspaceRoot } from "../../modules/analysis/output.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import { provModel, provSubject } from "../../modules/prov/document.ts";
import { loadOrGenerateKeypair, resetSigningForTests } from "../../modules/prov/signing.ts";
import { freshDb } from "../../test_support/db.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { ProvActor, ProvCommandRef, ProvStepRef, VerifyResult } from "../../types/prov.ts";
import type { ServerEnv } from "../http.ts";
import { provenanceRoutes } from "./provenance.ts";

// The routes alone, mounted at their path with no bearer check and no analysis guard: `app.test.ts`
// covers those. Each `as` cast of a body below reads JSON that the route under test builds from the same
// `src/api/` type. The recorder has no subscriber in this process, thus the flush before each read is a
// no-op and the stored column is what the routes read.
const app = new Hono<ServerEnv>().route("/api/v1/analyses/:analysisId/provenance", provenanceRoutes());

const ANALYSIS: Analysis = {
    id: "ana-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    name: asStr256("Prov Analysis"),
    slug: "prov-analysis",
    anchorId: "anc-1",
    projectId: null,
};

let home = "";

/** The analysis row, under an anchor folder that holds its marker, thus its output folder resolves. */
function seedAnalysis(): void {
    writeMarker(home, ANALYSIS.anchorId)._unsafeUnwrap();
    insertAnchor({ id: ANALYSIS.anchorId, createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    insertAnalysis(ANALYSIS)._unsafeUnwrap();
}

/** A stored document in which one command of a step wrote `runs/r1/s1/out.csv`. The chain columns are placeholders: the lineage reads only the document. */
function storeLineageDocument(): void {
    const system: ProvActor = { kind: "system", label: "inflexa cli", version: "0.0.1", commit: "abc1234" };
    const step: ProvStepRef = { runId: "r1", stepId: "s1" };
    const out = { path: "runs/r1/s1/out.csv", hash: "hashOut0001" };
    const command: ProvCommandRef = { kind: "command", command: "python make.py", exitCode: 0, outputs: [out], inputs: [] };
    const model = "anthropic/claude-sonnet-4-5";
    const doc = provModel.freshDocument(provSubject(ANALYSIS));
    applyProvEvent(provModel, doc, { type: "run_started", analysisId: ANALYSIS.id, actor: system, run: { runId: "r1", planSummary: "plan", startedAtMs: 1 } });
    applyProvEvent(provModel, doc, { type: "command_executed", analysisId: ANALYSIS.id, actor: system, step, command, model });
    applyProvEvent(provModel, doc, {
        type: "file_written",
        analysisId: ANALYSIS.id,
        actor: system,
        model,
        file: { ...out, size: 10, producer: "command" },
        generation: "command",
        step,
    });
    updateAnalysisProvenance(ANALYSIS.id, doc.unified(PROV_UNIFY_OPTIONS).serialize("json"), "chain", "signature")._unsafeUnwrap();
}

function post(path: string, body: unknown): Promise<Response> {
    return Promise.resolve(
        app.request(`/api/v1/analyses/${ANALYSIS.id}/provenance/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }),
    );
}

function get(path: string): Promise<Response> {
    return Promise.resolve(app.request(`/api/v1/analyses/${ANALYSIS.id}/provenance/${path}`));
}

beforeEach(() => {
    freshDb();
    invalidateWorkspaceRoot();
    home = mkdtempSync(join(tmpdir(), "inflexa-prov-route-"));
    // A signing key of this test only: the export signs with the key of this machine.
    resetSigningForTests(join(home, "prov_key.json"));
    seedAnalysis();
});

afterEach(() => {
    resetSigningForTests(null);
    rmSync(home, { recursive: true, force: true });
});

describe("POST {A}/provenance/export", () => {
    test("a PROV-JSON export lands in the output folder with its signed attestation", async () => {
        const response = await post("export", { format: "prov-json" });

        expect(response.status).toBe(200);
        const path = join(home, defaultOutputSubdir(ANALYSIS.slug), "provenance.json");
        expect((await response.json()) as ExportProvenanceResult).toEqual({ path, attestationPath: `${path}.sig.json` });
        expect(existsSync(path)).toBe(true);
        expect((JSON.parse(readFileSync(`${path}.sig.json`, "utf8")) as ProvAttestation).payloadType).toBe("application/json; profile=prov-json");
    });

    test("a PROV-N export has no attestation, and an absolute `output` is written as given", async () => {
        const output = join(home, "elsewhere.provn");

        const response = await post("export", { format: "prov-n", output });

        expect(response.status).toBe(200);
        expect((await response.json()) as ExportProvenanceResult).toEqual({ path: output });
        expect(existsSync(output)).toBe(true);
        expect(existsSync(`${output}.sig.json`)).toBe(false);
    });

    test("an unknown format or a relative `output` is 400 `validation_error`", async () => {
        for (const body of [{ format: "xml" }, { format: "prov-json", output: "relative.json" }, {}]) {
            const response = await post("export", body);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ error: "validation_error" });
        }
    });

    test("an analysis that does not exist is 404 `not_found`", async () => {
        const response = await app.request("/api/v1/analyses/nope/provenance/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ format: "prov-json" }),
        });

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found" });
    });
});

describe("GET {A}/provenance/verify", () => {
    test("gives the verdict of the kernel on the stored chain", async () => {
        const empty = await get("verify");
        expect(empty.status).toBe(200);
        expect((await empty.json()) as VerifyResult).toEqual({ status: "empty" });

        storeLineageDocument();
        (await loadOrGenerateKeypair())._unsafeUnwrap();
        // The placeholder chain hash cannot match the bytes, which is the verdict a changed document gets.
        const stored = (await (await get("verify")).json()) as VerifyResult;
        expect(stored.status).toBe("tampered");
    });
});

describe("GET {A}/provenance/lineage", () => {
    test("an analysis with no recorded provenance is 404 with the way forward", async () => {
        const response = await get("lineage?ref=out.csv");

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found", message: 'No provenance recorded for "Prov Analysis" yet — run an analysis first.' });
    });

    test("walks a file back to the command that wrote it, as a tree or as the flat graph", async () => {
        storeLineageDocument();

        const tree = (await (await get("lineage?ref=runs/r1/s1/out.csv")).json()) as LineageView;
        expect(tree.format).toBe("tree");
        if (tree.format !== "json") {
            expect(tree.text).toContain("runs/r1/s1/out.csv");
            expect(tree.text).toContain("python make.py");
        }

        const json = (await (await get("lineage?ref=runs/r1/s1/out.csv&format=json")).json()) as LineageView;
        expect(json.format).toBe("json");
        if (json.format === "json") expect(Object.values(json.lineage.nodes).some((n) => n.kind === "command")).toBe(true);
    });

    test("a ref that matches nothing is 404 with the known files", async () => {
        storeLineageDocument();

        const response = await get("lineage?ref=no-such-file.txt");

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found", details: { knownPaths: ["runs/r1/s1/out.csv"] } });
    });

    test("a bad format, a bad depth, or no ref is 400 `validation_error` before any read", async () => {
        const format = await get("lineage?ref=x&format=svg");
        expect(format.status).toBe(400);
        expect(await format.json()).toMatchObject({ error: "validation_error", message: 'Unknown format "svg". Use "tree", "json", "dot", or "mermaid".' });

        for (const query of ["lineage?ref=x&depth=0", "lineage?ref=x&depth=two", "lineage"]) {
            const response = await get(query);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ error: "validation_error" });
        }
    });
});
