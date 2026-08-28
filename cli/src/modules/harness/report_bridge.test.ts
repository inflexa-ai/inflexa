import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "bun";
import { attestationSchema, verifyAttestation } from "@inflexa-ai/prov-kernel";

import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { getAnalysisProvenance } from "../../db/primary_query.ts";
import { Bus } from "../../lib/bus.ts";
import { asStr256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { ProvModelId } from "../../types/prov.ts";
import { flushProvenanceAsync, initProvenanceRecording, resetProvenanceRecorderForTests } from "../prov/prov.ts";
import { resetSigningForTests } from "../prov/signing.ts";
import { emitReportObservation, installReportSessionModel, readReportProvenance } from "./report_bridge.ts";

// Bus-spy harness, matching `run_bridge.test.ts`: capture every `inflexa` event and always detach in
// cleanup so a lingering listener never double-counts a later test's events.
let captured: StampedEvent[] = [];
function spy(event: StampedEvent): void {
    captured.push(event);
}

const analysisId = "analysis-1";
const threadId = "thread-report-1";
const model: ProvModelId = "anthropic/claude-sonnet-4-5";

/** The single captured event, or a test failure when the bridge emitted none or more than one. */
function onlyEvent(): StampedEvent {
    expect(captured.length).toBe(1);
    return captured[0]!;
}

describe("report observation bridge", () => {
    beforeEach(() => {
        captured = [];
        Bus.on("inflexa", spy);
        installReportSessionModel(() => model);
    });
    afterEach(() => {
        Bus.off("inflexa", spy);
        installReportSessionModel(null);
    });

    test("a created report session carries the thread, the kind, and the parent", () => {
        emitReportObservation({ type: "create-session", analysisId, threadId, sessionKind: "report", parentThreadId: "thread-conv-1" });

        const event = onlyEvent();
        if (event.type !== "prov.session_created") throw new Error(`expected prov.session_created, got ${event.type}`);
        expect(event.analysisId).toBe(analysisId);
        expect(event.session).toEqual({ threadId, kind: "report", parentThreadId: "thread-conv-1" });
    });

    test("a created conversation session carries its kind and no parent key", () => {
        emitReportObservation({ type: "create-session", analysisId, threadId: "thread-conv-1", sessionKind: "conversation" });

        const event = onlyEvent();
        if (event.type !== "prov.session_created") throw new Error("expected prov.session_created");
        expect(event.session.kind).toBe("conversation");
        // A root session has no parent, so the key is absent rather than present and undefined.
        expect("parentThreadId" in event.session).toBe(false);
    });

    test("each block act maps onto its own member", () => {
        emitReportObservation({ type: "add-block", analysisId, threadId, blockId: "b1" });
        emitReportObservation({ type: "change-block", analysisId, threadId, blockId: "b2" });
        emitReportObservation({ type: "remove-block", analysisId, threadId, blockId: "b3" });
        emitReportObservation({ type: "move-block", analysisId, threadId, blockId: "b4" });

        expect(captured.map((e) => e.type)).toEqual([
            "prov.report_block_added",
            "prov.report_block_changed",
            "prov.report_block_removed",
            "prov.report_block_moved",
        ]);
        const moved = captured[3]!;
        if (moved.type !== "prov.report_block_moved") throw new Error("expected prov.report_block_moved");
        expect(moved.block).toEqual({ threadId, blockId: "b4" });
    });

    test("the title, the preview, and the version record carry the data of their act", () => {
        emitReportObservation({ type: "set-title", analysisId, threadId, title: "Differential expression" });
        emitReportObservation({ type: "preview", analysisId, threadId, pagePath: "report-sessions/t/page.html", documentHash: "h-doc" });
        emitReportObservation({ type: "record-version", analysisId, threadId, versionId: "v1", replaced: true });

        const [title, preview, version] = captured;
        if (title?.type !== "prov.report_title_set") throw new Error("expected prov.report_title_set");
        expect(title.title).toEqual({ threadId, title: "Differential expression" });
        if (preview?.type !== "prov.report_previewed") throw new Error("expected prov.report_previewed");
        expect(preview.preview).toEqual({ threadId, pagePath: "report-sessions/t/page.html", documentHash: "h-doc" });
        if (version?.type !== "prov.report_version_recorded") throw new Error("expected prov.report_version_recorded");
        expect(version.version).toEqual({ threadId, versionId: "v1", replaced: true });
    });

    test("a derivation carries its chain, restated pair by pair", () => {
        const sources = [
            { path: "data/inputs/f1/counts.csv", hash: "h1" },
            { path: "runs/r1/s1/output/de.csv", hash: "h2" },
        ];
        emitReportObservation({
            type: "run-derivation",
            analysisId,
            threadId,
            outputPath: "report-sessions/t/tables/top.csv",
            outputHash: "h-out",
            scriptHash: "h-script",
            sources,
        });

        const event = onlyEvent();
        if (event.type !== "prov.report_derivation_run") throw new Error("expected prov.report_derivation_run");
        expect(event.derivation.outputPath).toBe("report-sessions/t/tables/top.csv");
        expect(event.derivation.outputHash).toBe("h-out");
        expect(event.derivation.scriptHash).toBe("h-script");
        expect(event.derivation.sources).toEqual(sources);
        // Nothing that the tool still holds reaches a subscriber.
        expect(event.derivation.sources).not.toBe(sources);
        expect(event.derivation.sources[0]).not.toBe(sources[0]);
    });

    test("every act stamps the system actor", () => {
        emitReportObservation({ type: "add-block", analysisId, threadId, blockId: "b1" });

        const event = onlyEvent();
        if (event.type !== "prov.report_block_added") throw new Error("expected prov.report_block_added");
        expect(event.actor.kind).toBe("system");
    });

    test("the model is read at emit time, so a live switch re-stamps the later acts", () => {
        let live: ProvModelId = "anthropic/claude-sonnet-4-5";
        installReportSessionModel(() => live);

        emitReportObservation({ type: "add-block", analysisId, threadId, blockId: "b1" });
        live = "openai/gpt-5";
        emitReportObservation({ type: "add-block", analysisId, threadId, blockId: "b2" });

        const [first, second] = captured;
        if (first?.type !== "prov.report_block_added" || second?.type !== "prov.report_block_added") throw new Error("expected two block events");
        expect(first.model).toBe("anthropic/claude-sonnet-4-5");
        expect(second.model).toBe("openai/gpt-5");
    });

    test("with no live model the record is dropped rather than stamped with an invented name", () => {
        installReportSessionModel(null);

        emitReportObservation({ type: "add-block", analysisId, threadId, blockId: "b1" });

        expect(captured.length).toBe(0);
    });
});

const analysis: Analysis = {
    id: "a1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    name: asStr256("My Analysis"),
    slug: "my-analysis",
    anchorId: "anchor1",
    projectId: null,
};

describe("report provenance source", () => {
    let tmpDir: string;
    let keyPath: string;

    beforeEach(() => {
        freshDb();
        resetProvenanceRecorderForTests();
        // A real keypair in a temp dir: the flush refuses to write unsigned bytes, so a test that reads
        // the column at all needs signing to succeed.
        tmpDir = join(tmpdir(), `report-bridge-test-${randomUUIDv7()}`);
        mkdirSync(tmpDir, { recursive: true });
        keyPath = join(tmpDir, "prov_key.json");
        resetSigningForTests(keyPath);
        initProvenanceRecording(); // idempotent: subscribes once across the whole test run
        installReportSessionModel(() => model);

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();
    });

    afterEach(() => {
        resetSigningForTests(null);
        installReportSessionModel(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("a populated analysis gives the stored bytes and an attestation over them", async () => {
        emitReportObservation({ type: "add-block", analysisId: "a1", threadId, blockId: "b1" });
        await flushProvenanceAsync();

        const provenance = await readReportProvenance("a1");
        expect(provenance).toBeDefined();
        // The exact bytes of the column, which are the bytes the chain hash covers.
        expect(provenance!.document).toBe(getAnalysisProvenance("a1")._unsafeUnwrap()!);
        const attestation = attestationSchema.parse(JSON.parse(provenance!.attestation!));
        expect((await verifyAttestation(provenance!.document, attestation)).status).toBe("valid");
    });

    test("the drain runs first, so a read gives the bytes that include the act", async () => {
        // The recorder writes the column on a debounced flush, and this read never awaits one itself.
        emitReportObservation({ type: "record-version", analysisId: "a1", threadId, versionId: "v-drain", replaced: false });

        const provenance = await readReportProvenance("a1");
        expect(provenance).toBeDefined();
        expect(provenance!.document).toContain("v-drain");
    });

    test("an unknown analysis gives absence", async () => {
        expect(await readReportProvenance("no-such-analysis")).toBeUndefined();
    });

    test("an analysis whose provenance column is null gives absence", async () => {
        // The row exists, and no act has flushed a document onto it.
        expect(getAnalysisProvenance("a1")._unsafeUnwrap()).toBeNull();

        expect(await readReportProvenance("a1")).toBeUndefined();
    });

    test("a failed attestation build gives absence, and the document never reaches the page without its proof", async () => {
        emitReportObservation({ type: "add-block", analysisId: "a1", threadId, blockId: "b1" });
        await flushProvenanceAsync();
        expect(getAnalysisProvenance("a1")._unsafeUnwrap()).not.toBeNull();

        // A parseable key file that holds no importable key: the build of the attestation then fails
        // while the column still holds a document. The failure also reaches the log.
        const corruptPath = join(tmpDir, "corrupt_key.json");
        writeFileSync(corruptPath, JSON.stringify({ publicKey: {}, privateKey: {} }));
        resetSigningForTests(corruptPath);

        expect(await readReportProvenance("a1")).toBeUndefined();
    });
});
