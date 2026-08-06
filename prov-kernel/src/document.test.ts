import { describe, expect, test } from "bun:test";
import type { ProvDocument } from "@inflexa-ai/tsprov";
import { buildDocumentModel, createProvDocumentModel, defaultProvDigest, PROV_UNIFY_OPTIONS, type ProvDocumentModelInternal } from "./document.js";
import type { ProvActor, ProvStepRef } from "./types.js";

const actor: ProvActor = { kind: "system", label: "test-host", version: "0.0.0", commit: "abc123" };

const step: ProvStepRef = { runId: "r1", stepId: "s1" };
const outputKey = { path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" };
const inputKey = { path: "data/inputs/counts.csv", hash: "sha256:aaa" };

/** Append one full run's statements — the exact sequence a host recorder would drive. */
function appendRun(model: ProvDocumentModelInternal, doc: ProvDocument, analysisId: string): void {
    model.appendRunStarted(doc, analysisId, actor, { runId: "r1", planSummary: "test plan", startedAtMs: 1_700_000_000_000 });
    model.appendCommandExecuted(
        doc,
        analysisId,
        actor,
        step,
        {
            kind: "command",
            command: "python run.py",
            exitCode: 0,
            durationMs: 1200,
            outputs: [outputKey],
            inputs: [{ ...inputKey, source: "data" }],
        },
        "anthropic/test-model",
    );
    model.appendFileWritten(doc, analysisId, actor, { ...outputKey, size: 10, producer: "command" }, step, "command");
    model.appendInputUsed(doc, analysisId, actor, step, { ...inputKey, source: "data" });
    model.appendStepCompleted(
        doc,
        analysisId,
        actor,
        { runId: "r1", stepId: "s1", status: "completed", completedAtMs: 1_700_000_100_000, durationMs: 100_000 },
        "anthropic/test-model",
    );
    model.appendRunCompleted(doc, analysisId, actor, { runId: "r1", status: "completed", completedAtMs: 1_700_000_200_000, durationMs: 200_000 });
}

function serializeUnified(doc: ProvDocument): Record<string, Record<string, unknown>> {
    return JSON.parse(doc.unified(PROV_UNIFY_OPTIONS).serialize("json")) as Record<string, Record<string, unknown>>;
}

describe("QName derivation", () => {
    test("the same input derives the same QName", () => {
        const model = createProvDocumentModel();
        expect(model.fileQName(outputKey)).toBe(model.fileQName({ ...outputKey }));
        expect(model.inputQName({ path: "a.csv", isDir: false, anchorId: "anchor" })).toBe(
            model.inputQName({ path: "a.csv", isDir: false, anchorId: "anchor" }),
        );
        expect(model.commandQName(step, [outputKey])).toBe(model.commandQName({ ...step }, [{ ...outputKey }]));
        expect(model.modelAgentQName("anthropic/test-model")).toBe(model.modelAgentQName("anthropic/test-model"));
    });

    test("a custom digest re-derives every digest-bearing QName consistently", () => {
        const custom = createProvDocumentModel({ digest: (s) => `x${s.length.toString(36)}` });
        const fallback = createProvDocumentModel();
        expect(custom.fileQName(outputKey)).not.toBe(fallback.fileQName(outputKey));
        expect(custom.fileQName(outputKey)).toBe(custom.fileQName({ ...outputKey }));
        expect(custom.inputQName({ path: "a.csv", isDir: false, anchorId: null })).not.toBe(
            fallback.inputQName({ path: "a.csv", isDir: false, anchorId: null }),
        );
        expect(custom.commandQName(step, [outputKey])).not.toBe(fallback.commandQName(step, [outputKey]));
        expect(custom.modelAgentQName("anthropic/test-model")).not.toBe(fallback.modelAgentQName("anthropic/test-model"));
        // Digest-independent QNames are untouched by the injection.
        expect(custom.runQName("r1")).toBe(fallback.runQName("r1"));
        expect(custom.stepQName(step)).toBe(fallback.stepQName(step));
        expect(custom.analysisQName("a1")).toBe(fallback.analysisQName("a1"));
    });

    test("the default digest is the documented SHA-256 fold to base36", () => {
        // Guards the wire format: first 8 bytes of SHA-256, big-endian, base36.
        expect(defaultProvDigest("runs/r1/s1/output/result.csv|sha256:bbb")).toMatch(/^[0-9a-z]{1,13}$/);
        expect(defaultProvDigest("a")).toBe(defaultProvDigest("a"));
        expect(defaultProvDigest("a")).not.toBe(defaultProvDigest("b"));
    });
});

describe("document builders", () => {
    test("one run's statements produce the expected activity/entity/agent/relation keys", () => {
        const model = buildDocumentModel();
        const doc = model.freshDocument({ analysisId: "a1", name: "Test Analysis" });
        appendRun(model, doc, "a1");
        const json = serializeUnified(doc);

        expect(Object.keys(json.activity ?? {})).toContain("inflexa:run-r1");
        expect(Object.keys(json.activity ?? {})).toContain("inflexa:step-r1-s1");
        expect(Object.keys(json.activity ?? {})).toContain(model.commandQName(step, [outputKey]));
        expect(Object.keys(json.entity ?? {})).toContain("inflexa:analysis-a1");
        expect(Object.keys(json.entity ?? {})).toContain(model.fileQName(outputKey));
        expect(Object.keys(json.entity ?? {})).toContain(model.fileQName(inputKey));
        expect(Object.keys(json.agent ?? {})).toContain("inflexa:agent-system");
        expect(Object.keys(json.agent ?? {})).toContain(model.modelAgentQName("anthropic/test-model"));
        expect(Object.keys(json.wasInformedBy ?? {})).toContain("inflexa:informed-r1-s1");
        expect(Object.keys(json.used ?? {})).toContain("inflexa:used-run-r1");
    });

    test("re-building the same statements twice dedupes under unified()", () => {
        const model = buildDocumentModel();
        const doc = model.freshDocument({ analysisId: "a1" });
        appendRun(model, doc, "a1");
        appendRun(model, doc, "a1");
        const json = serializeUnified(doc);

        // Exactly one entity per file key.
        const fileQn = model.fileQName(outputKey);
        expect(Object.keys(json.entity ?? {}).filter((k) => k === fileQn).length).toBe(1);
        // Exactly one generation edge for the file, under its deterministic relation id.
        const genIds = Object.keys(json.wasGeneratedBy ?? {});
        expect(genIds.filter((k) => k.includes(defaultProvDigest(`${outputKey.path}|${outputKey.hash}`))).length).toBe(1);
    });

    test("no anonymous blank-node relations across the identified relation kinds", () => {
        const model = buildDocumentModel();
        const doc = model.freshDocument({ analysisId: "a1" });
        appendRun(model, doc, "a1");
        const json = serializeUnified(doc);

        for (const relKind of ["used", "wasGeneratedBy", "wasAssociatedWith", "wasInformedBy", "wasAttributedTo", "wasDerivedFrom"]) {
            for (const id of Object.keys(json[relKind] ?? {})) expect(id.startsWith("_:")).toBe(false);
        }
    });

    test("loadDocument round-trips a serialized document and rejects corrupt bytes", () => {
        const model = buildDocumentModel();
        const doc = model.freshDocument({ analysisId: "a1" });
        appendRun(model, doc, "a1");
        const json = doc.unified(PROV_UNIFY_OPTIONS).serialize("json");

        const reloaded = model.loadDocument({ analysisId: "a1" }, json);
        expect(reloaded.isOk()).toBe(true);
        expect(Object.keys(serializeUnified(reloaded._unsafeUnwrap()).activity ?? {})).toContain("inflexa:run-r1");

        expect(model.loadDocument({ analysisId: "a1" }, "this is not prov-json")._unsafeUnwrapErr().type).toBe("prov_corrupt");
    });
});
