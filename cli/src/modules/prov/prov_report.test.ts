import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "bun";
import { ProvDocument } from "@inflexa-ai/tsprov";

import { freshDb } from "../../test_support/db.ts";
import { insertAnchor, insertAnalysis } from "../../db/primary_mutation.ts";
import { getAnalysisIntegrity, getAnalysisProvenance } from "../../db/primary_query.ts";
import { Bus } from "../../lib/bus.ts";
import { asStr256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { ProvActor, ProvModelId } from "../../types/prov.ts";
import { cliProvDigest, provModel } from "./document.ts";
import { flushProvenanceAsync, initProvenanceRecording, resetProvenanceRecorderForTests } from "./prov.ts";
import { resetSigningForTests } from "./signing.ts";

// The report family is mapped in the HOST, not by the kernel dispatch, so these assertions read the
// FLUSHED document — the bytes the column holds after the signed flush — rather than a document the
// test built itself. That is the only state a later reader (an export, a page, a verifier) sees.

const analysis: Analysis = {
    id: "a1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    name: asStr256("My Analysis"),
    slug: "my-analysis",
    anchorId: "anchor1",
    projectId: null,
};

// The agent performs every report act, so the system actor stamps them all, with the model that
// drove the session riding beside it.
const system: ProvActor = { kind: "system", label: "inflexa cli", version: "0.0.1", commit: "abc1234" };
const model: ProvModelId = "anthropic/claude-sonnet-4-5";

const conversationThread = "thread-conv-1";
const reportThread = "thread-report-1";
const reportQn = `inflexa:report-${cliProvDigest(reportThread)}`;

/** PROV-JSON renders an attribute as a bare literal, a typed `{ $ }` object, or an array of either — flatten all three to strings. */
function attrValues(value: unknown): string[] {
    const list = Array.isArray(value) ? value : [value];
    return list.map((v) => (typeof v === "object" && v !== null && "$" in v ? String((v as { $: unknown }).$) : String(v)));
}

type ProvJson = {
    entity?: Record<string, Record<string, unknown>>;
    activity?: Record<string, Record<string, unknown>>;
    agent?: Record<string, Record<string, unknown>>;
};

/** Every action activity of one `prov:type` — a lifecycle action takes a fresh id per act, so the type is the only handle on it. */
function activitiesOfType(json: ProvJson, type: string): Record<string, unknown>[] {
    return Object.values(json.activity ?? {}).filter((a) => attrValues(a["prov:type"]).includes(type));
}

/** The single action activity of one `prov:type`; fails the test when the mapping wrote none or more than one. */
function oneActivityOfType(json: ProvJson, type: string): Record<string, unknown> {
    const found = activitiesOfType(json, type);
    expect(found.length).toBe(1);
    return found[0]!;
}

/** Drain the flush and read back the stored bytes — the exact document the signing path wrote. */
async function flushedDocument(): Promise<ProvDocument> {
    await flushProvenanceAsync();
    const stored = getAnalysisProvenance("a1")._unsafeUnwrap();
    expect(stored).not.toBeNull();
    return ProvDocument.deserialize(stored!, "json");
}

async function flushedJson(): Promise<ProvJson> {
    return JSON.parse((await flushedDocument()).serialize("json")) as ProvJson;
}

async function flushedProvN(): Promise<string> {
    return (await flushedDocument()).serialize("provn");
}

describe("report provenance recorder (report bus members → host mapping → column)", () => {
    let tmpDir: string;

    beforeEach(() => {
        freshDb();
        resetProvenanceRecorderForTests();
        // A real keypair in a temp dir: the flush refuses to write unsigned bytes, so a test that
        // reads the column at all needs signing to succeed.
        tmpDir = join(tmpdir(), `prov-report-test-${randomUUIDv7()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));
        initProvenanceRecording(); // idempotent: subscribes once across the whole test run

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();
    });

    afterEach(() => {
        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function emitReportSessionCreated(parentThreadId?: string): void {
        Bus.emit("inflexa", {
            type: "prov.session_created",
            analysisId: "a1",
            actor: system,
            model,
            session: { threadId: reportThread, kind: "report", parentThreadId },
        });
    }

    test("a report session creation mints the report entity, the CreateSession action, and leaves the signing columns intact", async () => {
        emitReportSessionCreated(conversationThread);
        const json = await flushedJson();

        const report = json.entity?.[reportQn];
        expect(report).toBeDefined();
        expect(attrValues(report!["prov:type"])).toContain("inflexa:Report");
        expect(attrValues(report!["inflexa:threadId"])).toEqual([reportThread]);
        expect(attrValues(report!["inflexa:parentThreadId"])).toEqual([conversationThread]);

        const action = oneActivityOfType(json, "inflexa:CreateSession");
        expect(attrValues(action["inflexa:threadId"])).toEqual([reportThread]);
        expect(attrValues(action["inflexa:sessionKind"])).toEqual(["report"]);
        expect(attrValues(action["inflexa:parentThreadId"])).toEqual([conversationThread]);

        // The creation is the report's single generation and its attribution, the pair the analysis
        // subject gets from `appendCreation`.
        const provn = await flushedProvN();
        expect(provn).toMatch(new RegExp(`wasGeneratedBy\\(${reportQn}, inflexa:action-`));
        expect(provn).toContain(`wasAttributedTo(${reportQn}, inflexa:agent-system)`);

        // The signing path is untouched by the new family: the column, the chain hash, and the
        // signature are written exactly as they are for a core event.
        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(integrity!.provenance).not.toBeNull();
        expect(integrity!.chainHash).not.toBeNull();
        expect(integrity!.signature).not.toBeNull();
    });

    test("a conversation session creation records the action alone and mints no report entity", async () => {
        Bus.emit("inflexa", {
            type: "prov.session_created",
            analysisId: "a1",
            actor: system,
            model,
            session: { threadId: conversationThread, kind: "conversation" },
        });
        const json = await flushedJson();

        const action = oneActivityOfType(json, "inflexa:CreateSession");
        expect(attrValues(action["inflexa:threadId"])).toEqual([conversationThread]);
        expect(attrValues(action["inflexa:sessionKind"])).toEqual(["conversation"]);
        // A conversation owns no document, so nothing under the report QName space exists.
        expect(Object.keys(json.entity ?? {}).filter((qn) => qn.startsWith("inflexa:report-"))).toEqual([]);
    });

    test("each block act lands its own typed action carrying the thread and the block", async () => {
        emitReportSessionCreated(conversationThread);
        const acts = [
            ["prov.report_block_added", "inflexa:AddReportBlock", "block-a"],
            ["prov.report_block_changed", "inflexa:ChangeReportBlock", "block-b"],
            ["prov.report_block_removed", "inflexa:RemoveReportBlock", "block-c"],
            ["prov.report_block_moved", "inflexa:MoveReportBlock", "block-d"],
        ] as const;
        for (const [type, , blockId] of acts) {
            Bus.emit("inflexa", { type, analysisId: "a1", actor: system, model, block: { threadId: reportThread, blockId } });
        }
        const json = await flushedJson();

        for (const [, activityType, blockId] of acts) {
            const action = oneActivityOfType(json, activityType);
            expect(attrValues(action["inflexa:threadId"])).toEqual([reportThread]);
            expect(attrValues(action["inflexa:blockId"])).toEqual([blockId]);
        }

        // Each act `used` the report it operated on, so the four acts and the report node are one
        // connected subgraph rather than four attribute-tagged islands.
        const provn = await flushedProvN();
        expect((provn.match(new RegExp(`used\\(inflexa:action-[\\w-]+, ${reportQn}`, "g")) ?? []).length).toBe(4);
    });

    test("the title, the derivation, and the preview each land one typed action with the data of their act", async () => {
        emitReportSessionCreated(conversationThread);
        Bus.emit("inflexa", { type: "prov.report_title_set", analysisId: "a1", actor: system, model, title: { threadId: reportThread, title: "DE results" } });
        Bus.emit("inflexa", {
            type: "prov.report_derivation_run",
            analysisId: "a1",
            actor: system,
            model,
            derivation: {
                threadId: reportThread,
                outputPath: "reports/r1/table.csv",
                outputHash: "hashOut001",
                scriptHash: "hashScr001",
                sources: [
                    { path: "runs/run-001/step-de/output/de.csv", hash: "hashDe0001" },
                    { path: "data/inputs/counts.csv", hash: "hashCount1" },
                ],
            },
        });
        Bus.emit("inflexa", {
            type: "prov.report_previewed",
            analysisId: "a1",
            actor: system,
            model,
            preview: { threadId: reportThread, pagePath: "report-sessions/t1/index.html", documentHash: "hashDoc001" },
        });
        const json = await flushedJson();

        const title = oneActivityOfType(json, "inflexa:SetReportTitle");
        expect(attrValues(title["inflexa:threadId"])).toEqual([reportThread]);
        expect(attrValues(title["inflexa:title"])).toEqual(["DE results"]);

        const derivation = oneActivityOfType(json, "inflexa:RunReportDerivation");
        expect(attrValues(derivation["inflexa:outputPath"])).toEqual(["reports/r1/table.csv"]);
        expect(attrValues(derivation["inflexa:outputHash"])).toEqual(["hashOut001"]);
        expect(attrValues(derivation["inflexa:scriptHash"])).toEqual(["hashScr001"]);
        // The `path|hash` encoding keeps each source paired; two parallel attributes would not.
        expect(attrValues(derivation["inflexa:source"]).sort()).toEqual(
            ["data/inputs/counts.csv|hashCount1", "runs/run-001/step-de/output/de.csv|hashDe0001"].sort(),
        );

        const preview = oneActivityOfType(json, "inflexa:PreviewReport");
        expect(attrValues(preview["inflexa:pagePath"])).toEqual(["report-sessions/t1/index.html"]);
        expect(attrValues(preview["inflexa:documentHash"])).toEqual(["hashDoc001"]);
    });

    test("an act for a thread with no report entity mints one, without a parent thread", async () => {
        // No creation event: the session started before the seam was bound, or its document predates
        // the family. The act must still land, and it must land on a report node.
        Bus.emit("inflexa", {
            type: "prov.report_block_added",
            analysisId: "a1",
            actor: system,
            model,
            block: { threadId: reportThread, blockId: "block-a" },
        });
        const json = await flushedJson();

        const report = json.entity?.[reportQn];
        expect(report).toBeDefined();
        expect(attrValues(report!["prov:type"])).toContain("inflexa:Report");
        expect(attrValues(report!["inflexa:threadId"])).toEqual([reportThread]);
        // Only the creation event knows a parent, so a lazy mint carries none.
        expect(report!["inflexa:parentThreadId"]).toBeUndefined();
        expect(activitiesOfType(json, "inflexa:AddReportBlock").length).toBe(1);
    });

    test("a version record mints a ReportVersion entity that specializes its report", async () => {
        emitReportSessionCreated(conversationThread);
        Bus.emit("inflexa", {
            type: "prov.report_version_recorded",
            analysisId: "a1",
            actor: system,
            model,
            version: { threadId: reportThread, versionId: "ver-1", replaced: true },
        });
        const json = await flushedJson();
        const versionQn = `inflexa:report-version-${cliProvDigest("ver-1")}`;

        const version = json.entity?.[versionQn];
        expect(version).toBeDefined();
        expect(attrValues(version!["prov:type"])).toContain("inflexa:ReportVersion");
        expect(attrValues(version!["inflexa:versionId"])).toEqual(["ver-1"]);
        expect(attrValues(version!["inflexa:threadId"])).toEqual([reportThread]);

        const action = oneActivityOfType(json, "inflexa:RecordReportVersion");
        expect(attrValues(action["inflexa:versionId"])).toEqual(["ver-1"]);
        expect(attrValues(action["inflexa:replaced"])).toEqual(["true"]);

        // A version IS the report fixed at one point in time — `specializationOf`, the entity-to-entity
        // edge, never `wasAttributedTo` (which takes an agent).
        const provn = await flushedProvN();
        expect(provn).toContain(`specializationOf(${versionQn}, ${reportQn})`);
        expect(provn).toMatch(new RegExp(`wasGeneratedBy\\(${versionQn}, inflexa:action-`));
    });

    test("a version record for an unseen thread mints the report first and specializes onto it", async () => {
        Bus.emit("inflexa", {
            type: "prov.report_version_recorded",
            analysisId: "a1",
            actor: system,
            model,
            version: { threadId: reportThread, versionId: "ver-2", replaced: false },
        });
        const json = await flushedJson();
        const versionQn = `inflexa:report-version-${cliProvDigest("ver-2")}`;

        expect(json.entity?.[reportQn]).toBeDefined();
        expect(json.entity?.[reportQn]?.["inflexa:parentThreadId"]).toBeUndefined();
        expect(json.entity?.[versionQn]).toBeDefined();
        expect(await flushedProvN()).toContain(`specializationOf(${versionQn}, ${reportQn})`);
    });

    test("a re-emitted version record adds no second specialization edge", async () => {
        const event = {
            type: "prov.report_version_recorded",
            analysisId: "a1",
            actor: system,
            model,
            version: { threadId: reportThread, versionId: "ver-3", replaced: false },
        } as const;
        emitReportSessionCreated(conversationThread);
        Bus.emit("inflexa", { ...event });
        Bus.emit("inflexa", { ...event });
        const provn = await flushedProvN();

        // `specializationOf` takes no identifier in tsprov, so `unified()` cannot collapse a second
        // copy — the mapping writes it only on the entity's first declaration.
        expect((provn.match(/specializationOf\(/g) ?? []).length).toBe(1);
    });

    test("the model rides as an inflexa:Model software agent on behalf of the system agent", async () => {
        emitReportSessionCreated(conversationThread);
        Bus.emit("inflexa", {
            type: "prov.report_block_added",
            analysisId: "a1",
            actor: system,
            model,
            block: { threadId: reportThread, blockId: "block-a" },
        });
        const modelQn = provModel.modelAgentQName(model);
        const json = await flushedJson();

        const agent = json.agent?.[modelQn];
        expect(agent).toBeDefined();
        expect(attrValues(agent!["prov:type"])).toContain("inflexa:Model");
        expect(attrValues(agent!["prov:type"])).toContain("prov:SoftwareAgent");
        expect(attrValues(agent!["inflexa:model"])).toEqual([model]);

        const provn = await flushedProvN();
        // One delegation across both acts: its identifier is the kernel's, so the report records and
        // the step records share a single `(model, responsible)` edge.
        expect((provn.match(/actedOnBehalfOf\(/g) ?? []).length).toBe(1);
        expect(provn).toMatch(new RegExp(`actedOnBehalfOf\\(inflexa:delegation-[\\w-]+; ${modelQn}, inflexa:agent-system`));
        // Both actions are associated with the model agent, beside their own actor association.
        expect((provn.match(new RegExp(`wasAssociatedWith\\(inflexa:action-[\\w-]+, ${modelQn}`, "g")) ?? []).length).toBe(2);
    });

    test("the report records round-trip losslessly through the stored PROV-JSON", async () => {
        emitReportSessionCreated(conversationThread);
        Bus.emit("inflexa", { type: "prov.report_title_set", analysisId: "a1", actor: system, model, title: { threadId: reportThread, title: "DE results" } });
        Bus.emit("inflexa", {
            type: "prov.report_version_recorded",
            analysisId: "a1",
            actor: system,
            model,
            version: { threadId: reportThread, versionId: "ver-4", replaced: false },
        });
        const doc = await flushedDocument();
        expect(doc.equals(ProvDocument.deserialize(doc.serialize("json"), "json"))).toBe(true);
    });
});
