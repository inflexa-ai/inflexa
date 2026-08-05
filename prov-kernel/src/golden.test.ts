import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProvDocument } from "@inflexa-ai/tsprov";
import { createProvDocumentModel, PROV_UNIFY_OPTIONS, type ProvDocumentModel } from "./document.js";
import type { ProvActor, ProvModelId } from "./types.js";

/**
 * The golden document: a small, fully deterministic run built from fixed ids and fixed epoch-ms
 * timestamps under the default digest, compared against a committed fixture. It guards
 * cross-recorder drift — any change to a QName derivation, a relation-id scheme, an attribute
 * name, or the unify semantics shows up here as a fixture diff, and an independent writer (e.g. a
 * Go implementation) can target the same fixture. Never uses `Date.now()`: the execution builders
 * take their times from the payload, so fixed inputs give fixed bytes.
 */

const actor: ProvActor = { kind: "system", label: "golden-host", version: "1.0.0", commit: "deadbeef" };
const model: ProvModelId = "anthropic/golden-model";

function buildGoldenDocument(m: ProvDocumentModel): ProvDocument {
    const doc = m.freshDocument({ analysisId: "a-golden", name: "Golden Analysis", slug: "golden-analysis" });
    const step = { runId: "r1", stepId: "s1" };
    m.appendRunStarted(doc, "a-golden", actor, { runId: "r1", planSummary: "golden plan", startedAtMs: 1_700_000_000_000 });
    m.appendCommandExecuted(
        doc,
        "a-golden",
        actor,
        step,
        {
            kind: "command",
            command: "python run.py",
            args: ["--seed", "42"],
            exitCode: 0,
            durationMs: 1200,
            scriptPath: "runs/r1/s1/scripts/run.py",
            outputs: [
                { path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" },
                { path: "runs/r1/s1/scripts/run.py", hash: "sha256:ccc" },
            ],
            inputs: [{ path: "data/inputs/counts.csv", hash: "sha256:aaa", source: "data", fileId: "file-1" }],
        },
        model,
    );
    m.appendFileWritten(doc, "a-golden", actor, { path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb", size: 10, producer: "command" }, step, "command");
    m.appendFileWritten(doc, "a-golden", actor, { path: "runs/r1/s1/logs/run.log", hash: "sha256:ddd", size: 3, producer: "command" }, step, "step");
    m.appendInputUsed(doc, "a-golden", actor, step, { path: "data/inputs/counts.csv", hash: "sha256:aaa", source: "data", fileId: "file-1" });
    m.appendStepCompleted(
        doc,
        "a-golden",
        actor,
        { runId: "r1", stepId: "s1", status: "completed", completedAtMs: 1_700_000_100_000, durationMs: 100_000 },
        model,
    );
    m.appendRunCompleted(doc, "a-golden", actor, { runId: "r1", status: "completed", completedAtMs: 1_700_000_200_000, durationMs: 200_000 });
    return doc;
}

describe("golden document", () => {
    test("the deterministic run serializes to the committed fixture", () => {
        const m = createProvDocumentModel();
        const json = JSON.parse(buildGoldenDocument(m).unified(PROV_UNIFY_OPTIONS).serialize("json")) as unknown;
        const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/golden-document.json", import.meta.url), "utf8")) as unknown;
        expect(json).toEqual(fixture);
    });

    test("building the document twice yields identical bytes", () => {
        const a = buildGoldenDocument(createProvDocumentModel()).unified(PROV_UNIFY_OPTIONS).serialize("json");
        const b = buildGoldenDocument(createProvDocumentModel()).unified(PROV_UNIFY_OPTIONS).serialize("json");
        expect(a).toBe(b);
    });
});
