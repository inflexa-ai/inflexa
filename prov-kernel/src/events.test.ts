import { describe, expect, test } from "bun:test";
import { createProvDocumentModel, defaultProvDigest, PROV_UNIFY_OPTIONS, type ProvDocumentModel } from "./document.js";
import { applyProvEvent, type ProvEvent } from "./events.js";
import type { ProvActor } from "./types.js";

/**
 * Event-driven coverage of the core switch: each test drives {@link applyProvEvent} against
 * `createProvDocumentModel()` and asserts on the serialized statements. Fixed ids and fixed
 * epoch-ms timestamps only — never `Date.now()`.
 */

const actor: ProvActor = { kind: "system", label: "test-host", version: "0.0.0", commit: "abc123" };

type ParsedDoc = Record<string, Record<string, unknown>>;

function makeModel(): ProvDocumentModel {
    let actionN = 0;
    return createProvDocumentModel({
        now: () => new Date(1_699_999_999_500),
        mintActionId: () => `evt-${++actionN}`,
    });
}

function serialize(model: ProvDocumentModel, events: ProvEvent[], analysisId = "a1"): ParsedDoc {
    const doc = model.freshDocument({ analysisId, name: "Test Analysis" });
    for (const event of events) applyProvEvent(model, doc, event);
    return JSON.parse(doc.unified(PROV_UNIFY_OPTIONS).serialize("json")) as ParsedDoc;
}

function runEvents(analysisId: string): ProvEvent[] {
    const step = { runId: "r1", stepId: "s1" };
    return [
        { type: "run_started", analysisId, actor, run: { runId: "r1", planSummary: "test plan", startedAtMs: 1_700_000_000_000 } },
        {
            type: "command_executed",
            analysisId,
            actor,
            step,
            model: "anthropic/test-model",
            command: {
                kind: "command",
                command: "python run.py",
                exitCode: 0,
                durationMs: 1200,
                outputs: [{ path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" }],
                inputs: [{ path: "data/inputs/counts.csv", hash: "sha256:aaa", source: "data" }],
            },
        },
        {
            type: "file_written",
            analysisId,
            actor,
            step,
            generation: "command",
            file: { path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb", size: 10, producer: "command" },
        },
        { type: "input_used", analysisId, actor, step, input: { path: "data/inputs/counts.csv", hash: "sha256:aaa", source: "data" } },
        {
            type: "step_completed",
            analysisId,
            actor,
            model: "anthropic/test-model",
            outcome: { runId: "r1", stepId: "s1", status: "completed", completedAtMs: 1_700_000_100_000, durationMs: 100_000 },
        },
        {
            type: "run_completed",
            analysisId,
            actor,
            outcome: { runId: "r1", status: "completed", completedAtMs: 1_700_000_200_000, durationMs: 200_000 },
        },
    ];
}

const outputDigest = defaultProvDigest("runs/r1/s1/output/result.csv|sha256:bbb");
const inputDigest = defaultProvDigest("data/inputs/counts.csv|sha256:aaa");
const groupDigest = defaultProvDigest(outputDigest);
const systemAgentDigest = defaultProvDigest("inflexa:agent-system");

describe("applyProvEvent", () => {
    test("one run's events produce the run, step, command, file, and agent statements", () => {
        const model = makeModel();
        const doc = serialize(model, runEvents("a1"));

        expect(Object.keys(doc.activity ?? {})).toContain("inflexa:run-r1");
        expect(Object.keys(doc.activity ?? {})).toContain("inflexa:step-r1-s1");
        expect(Object.keys(doc.activity ?? {})).toContain(`inflexa:cmd-r1-s1-${groupDigest}`);
        expect(Object.keys(doc.agent ?? {})).toContain("inflexa:agent-system");
        expect(Object.keys(doc.agent ?? {})).toContain(model.modelAgentQName("anthropic/test-model"));
        expect(Object.keys(doc.entity ?? {})).toContain(model.fileQName({ path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" }));
    });

    test("re-emission of the same events dedupes under unified() with no blank-node relations", () => {
        const model = makeModel();
        const doc = serialize(model, [...runEvents("a1"), ...runEvents("a1")]);

        const fileQn = model.fileQName({ path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" });
        expect(Object.keys(doc.entity ?? {}).filter((k) => k === fileQn).length).toBe(1);
        // Exactly one generation edge for the file, under its deterministic relation id.
        const genIds = Object.keys(doc.wasGeneratedBy ?? {});
        expect(genIds.filter((k) => k.includes(outputDigest)).length).toBe(1);
        // No anonymous (blank-node) relations — every execution relation must carry its deterministic id.
        for (const relKind of ["used", "wasGeneratedBy", "wasAssociatedWith", "wasInformedBy", "wasAttributedTo", "wasDerivedFrom"]) {
            for (const id of Object.keys(doc[relKind] ?? {})) expect(id.startsWith("_:")).toBe(false);
        }
    });

    test("a command event appends the command activity, its reads, and its generation authority", () => {
        const doc = serialize(makeModel(), runEvents("a1"));

        const cmdQn = `inflexa:cmd-r1-s1-${groupDigest}`;
        expect(doc.activity?.[cmdQn]).toMatchObject({
            "prov:type": "inflexa:Command",
            "inflexa:command": "python run.py",
            "inflexa:exitCode": { $: 0, type: "xsd:int" },
            "inflexa:durationMs": { $: 1200, type: "xsd:int" },
        });
        expect(doc.wasInformedBy?.[`inflexa:informed-cmd-r1-s1-${groupDigest}`]).toMatchObject({
            "prov:informed": cmdQn,
            "prov:informant": "inflexa:step-r1-s1",
        });
        expect(doc.used?.[`inflexa:used-cmd-r1-s1-${groupDigest}-${inputDigest}`]).toMatchObject({ "prov:activity": cmdQn });
        expect(doc.wasGeneratedBy?.[`inflexa:gen-${outputDigest}`]).toMatchObject({
            "prov:entity": `inflexa:file-${outputDigest}`,
            "prov:activity": cmdQn,
        });
    });

    test("file and input events append the entities, attribution, derivation, and the step read", () => {
        const doc = serialize(makeModel(), runEvents("a1"));

        expect(doc.entity?.[`inflexa:file-${outputDigest}`]).toMatchObject({
            "prov:type": "inflexa:File",
            "inflexa:path": "runs/r1/s1/output/result.csv",
            "inflexa:hash": "sha256:bbb",
            "inflexa:size": { $: 10, type: "xsd:int" },
            "inflexa:producer": "command",
        });
        expect(doc.wasAttributedTo?.[`inflexa:attr-${outputDigest}-${systemAgentDigest}`]).toMatchObject({ "prov:agent": "inflexa:agent-system" });
        expect(doc.wasDerivedFrom?.[`inflexa:deriv-${outputDigest}`]).toMatchObject({ "prov:usedEntity": "inflexa:analysis-a1" });
        expect(doc.entity?.[`inflexa:file-${inputDigest}`]).toMatchObject({
            "inflexa:path": "data/inputs/counts.csv",
            "inflexa:hash": "sha256:aaa",
            "inflexa:source": "data",
        });
        expect(doc.used?.[`inflexa:used-input-r1-s1-${inputDigest}`]).toMatchObject({
            "prov:activity": "inflexa:step-r1-s1",
            "prov:entity": `inflexa:file-${inputDigest}`,
        });
    });

    test("run and step lifecycle events carry the payload timestamps and terminal attributes", () => {
        const doc = serialize(makeModel(), runEvents("a1"));

        expect(doc.activity?.["inflexa:run-r1"]).toMatchObject({
            "prov:startTime": "2023-11-14T22:13:20+00:00",
            "prov:endTime": "2023-11-14T22:16:40+00:00",
            "prov:type": "inflexa:Run",
            "inflexa:planSummary": "test plan",
            "inflexa:status": "completed",
            "inflexa:durationMs": { $: 200_000, type: "xsd:int" },
        });
        expect(doc.activity?.["inflexa:step-r1-s1"]).toMatchObject({
            "prov:endTime": "2023-11-14T22:15:00+00:00",
            "prov:type": "inflexa:Step",
            "inflexa:status": "completed",
        });
        expect(doc.wasInformedBy?.["inflexa:informed-r1-s1"]).toMatchObject({ "prov:informed": "inflexa:step-r1-s1", "prov:informant": "inflexa:run-r1" });
        expect(doc.wasAssociatedWith?.[`inflexa:assoc-run-r1-${systemAgentDigest}`]).toBeDefined();
        expect(doc.wasAssociatedWith?.[`inflexa:assoc-step-r1-s1-${systemAgentDigest}`]).toBeDefined();
        expect(doc.used?.["inflexa:used-run-r1"]).toMatchObject({ "prov:entity": "inflexa:analysis-a1" });
    });

    test("analysis lifecycle events mint typed action activities against the subject and the input", () => {
        const model = makeModel();
        const input = { path: "data/inputs/counts.csv", isDir: false, anchorId: "anchor-1" };
        const doc = serialize(model, [
            { type: "analysis_created", analysisId: "a1", actor },
            { type: "input_added", analysisId: "a1", actor, input, derivedFromAnalysisId: "a0" },
            { type: "input_removed", analysisId: "a1", actor, input },
        ]);

        expect(doc.activity?.["inflexa:action-evt-1"]).toMatchObject({ "prov:type": "inflexa:CreateAnalysis" });
        expect(doc.activity?.["inflexa:action-evt-2"]).toMatchObject({ "prov:type": "inflexa:AddInput" });
        expect(doc.activity?.["inflexa:action-evt-3"]).toMatchObject({ "prov:type": "inflexa:RemoveInput" });
        const inputQn = model.inputQName(input);
        expect(doc.entity?.[inputQn]).toMatchObject({ "prov:type": "inflexa:Input", "inflexa:isDir": false });
        expect(Object.values(doc.wasGeneratedBy ?? {})).toContainEqual(
            expect.objectContaining({ "prov:entity": "inflexa:analysis-a1", "prov:activity": "inflexa:action-evt-1" }),
        );
        expect(Object.values(doc.wasDerivedFrom ?? {})).toContainEqual(
            expect.objectContaining({ "prov:generatedEntity": inputQn, "prov:usedEntity": "inflexa:analysis-a0" }),
        );
        expect(Object.values(doc.wasInvalidatedBy ?? {})).toContainEqual(
            expect.objectContaining({ "prov:entity": inputQn, "prov:activity": "inflexa:action-evt-3" }),
        );
    });

    test("an event outside the union throws instead of appending", () => {
        const model = makeModel();
        const doc = model.freshDocument({ analysisId: "a1" });
        const rogue = { type: "not_an_event", analysisId: "a1", actor } as unknown as ProvEvent;
        expect(() => applyProvEvent(model, doc, rogue)).toThrow("unhandled prov event type");
    });
});
