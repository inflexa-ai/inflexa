import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentSession, ArtifactManifestEntry, ArtifactRegistrationInput, ProvenanceCollector, RunProvenanceEvent } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { ProvFileRef } from "../../types/prov.ts";
import { fileQName } from "../prov/document.ts";
import { createBusArtifactRegistry, createRunProvenanceEmitter } from "./prov_bridge.ts";

// Bus-spy harness: capture every `inflexa` event the adapter emits, always detaching in cleanup so
// the listener never leaks across tests (a lingering spy would double-count later files' events).
let captured: StampedEvent[] = [];
function spy(event: StampedEvent): void {
    captured.push(event);
}
beforeEach(() => {
    captured = [];
    Bus.on("inflexa", spy);
});
afterEach(() => {
    Bus.off("inflexa", spy);
});

// The tracked-input shape the adapter reads off `getTrackedInputs()` — the subset of the harness's
// `InputRef` the adapter touches. `InputRef` is not re-exported from the barrel, and the `as unknown
// as` stub below never needs the full shape, so this structural mirror is honest.
type FakeTrackedInput = { path: string; hash: string; source: "data" | "upstream" | "prior" | "artifacts"; fileId?: string };

// The adapter reads `getRecords()` (→ `{outputPath, producer.type}`) and `getTrackedInputs()` off the
// collector, so a structural stub of those two methods is cleaner than instantiating the real class
// (whose private fields would reject an object literal and whose ingest methods need write fixtures).
// The `as unknown as` bridges the private-member gap the adapter never touches.
function fakeCollector(
    records: Array<{ outputPath: string; producerType: ProvFileRef["producer"] }>,
    trackedInputs: FakeTrackedInput[] = [],
): ProvenanceCollector {
    const recs = records.map((r) => ({ outputPath: r.outputPath, producer: { type: r.producerType } }));
    return { getRecords: () => recs, getTrackedInputs: () => trackedInputs } as unknown as ProvenanceCollector;
}

// The bus adapter addresses no external system, so it ignores the session entirely — an empty stand-in
// is honest here (the adapter never dereferences it).
const noSession = {} as unknown as AgentSession;

function entry(path: string, hash: string | undefined, size: number): ArtifactManifestEntry {
    return { stepId: "de-analysis", runId: "run-001", path, size, type: "output", hash };
}

describe("createBusArtifactRegistry — register", () => {
    test("a step emits one file_written per entry, one input_used per non-artifacts input, and NO step_completed", async () => {
        const registry = createBusArtifactRegistry();
        const artifacts = [entry("output/a.csv", "sha256:aaa", 10), entry("figures/b.png", "sha256:bbb", 20), entry("output/c.txt", "sha256:ccc", 30)];
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts,
            collector: fakeCollector(
                [
                    { outputPath: "output/a.csv", producerType: "command" },
                    { outputPath: "figures/b.png", producerType: "file_tool" },
                    { outputPath: "output/c.txt", producerType: "command" },
                ],
                // Mixed sources: three non-artifacts reads (one per classification) + one `artifacts`
                // read (the step's own output) that MUST be skipped. Paths are container-absolute.
                [
                    { path: "/an-1/data/inputs/raw.csv", hash: "sha256:d1", source: "data", fileId: "file-1" },
                    { path: "/an-1/runs/run-001/step-up/output/up.csv", hash: "sha256:u1", source: "upstream" },
                    { path: "/an-1/runs/run-000/step-de/output/results.csv", hash: "sha256:p1", source: "prior" },
                    { path: "/an-1/runs/run-001/de-analysis/output/a.csv", hash: "sha256:aaa", source: "artifacts" },
                ],
            ),
        };

        const result = await registry.register(input, noSession);

        // Files first (one per entry), then inputs (one per non-artifacts ref); the `artifacts` read is
        // skipped, and NO step lifecycle event is emitted from the registry.
        expect(captured.map((e) => e.type)).toEqual([
            "prov.file_written",
            "prov.file_written",
            "prov.file_written",
            "prov.input_used",
            "prov.input_used",
            "prov.input_used",
        ]);

        // Paths are prefixed to the analysis-scoped form the harness's local ledger row carries;
        // hashes and sizes pass through verbatim; producers join from the collector's records.
        const files = captured.filter((e): e is Extract<StampedEvent, { type: "prov.file_written" }> => e.type === "prov.file_written");
        expect(files.map((f) => f.file.path)).toEqual([
            "runs/run-001/de-analysis/output/a.csv",
            "runs/run-001/de-analysis/figures/b.png",
            "runs/run-001/de-analysis/output/c.txt",
        ]);
        expect(files.map((f) => f.file.hash)).toEqual(["sha256:aaa", "sha256:bbb", "sha256:ccc"]);
        expect(files.map((f) => f.file.size)).toEqual([10, 20, 30]);
        expect(files.map((f) => f.file.producer)).toEqual(["command", "file_tool", "command"]);
        for (const f of files) {
            expect(f.analysisId).toBe("an-1");
            expect(f.actor.kind).toBe("system");
            expect(f.step).toEqual({ runId: "run-001", stepId: "de-analysis" });
        }

        // Inputs: container mount prefix stripped to analysis-relative, attested hash + source pass
        // through, fileId only when present, `artifacts` never surfaces, and each carries the pure step ref.
        const inputs = captured.filter((e): e is Extract<StampedEvent, { type: "prov.input_used" }> => e.type === "prov.input_used");
        expect(inputs.map((i) => i.input.path)).toEqual([
            "data/inputs/raw.csv",
            "runs/run-001/step-up/output/up.csv",
            "runs/run-000/step-de/output/results.csv",
        ]);
        expect(inputs.map((i) => i.input.source)).toEqual(["data", "upstream", "prior"]);
        expect(inputs.map((i) => i.input.hash)).toEqual(["sha256:d1", "sha256:u1", "sha256:p1"]);
        // fileId rides through only for the data read that carried one.
        expect(inputs.map((i) => i.input.fileId)).toEqual(["file-1", undefined, undefined]);
        for (const i of inputs) {
            expect(i.analysisId).toBe("an-1");
            expect(i.actor.kind).toBe("system");
            expect(i.step).toEqual({ runId: "run-001", stepId: "de-analysis" });
        }

        // Only files register (inputs are reads, not artifacts); each externalId is the file's QName.
        expect(result.failedCount).toBe(0);
        expect(result.failed).toEqual([]);
        expect(result.registered).toEqual(files.map((f) => ({ path: f.file.path, externalId: fileQName(f.file) })));
    });

    test("a prior read strips to the SAME analysis-relative path the producing run's file event used", async () => {
        const registry = createBusArtifactRegistry();
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-002",
            stepId: "de-analysis",
            artifacts: [],
            collector: fakeCollector([], [{ path: "/an-1/runs/run-001/step-de/output/results.csv", hash: "sha256:same", source: "prior" }]),
        };

        await registry.register(input, noSession);

        const inputEvent = captured.find((e) => e.type === "prov.input_used");
        if (inputEvent?.type !== "prov.input_used") throw new Error("expected a prov.input_used event");
        // Byte-identical to the analysis-scoped path run-001's step-de `prov.file_written` carried, so
        // fileQName resolves both to one entity — the cross-run chain the design keys on.
        expect(inputEvent.input.path).toBe("runs/run-001/step-de/output/results.csv");
        expect(fileQName(inputEvent.input)).toBe(fileQName({ path: "runs/run-001/step-de/output/results.csv", hash: "sha256:same" }));
    });

    test("an entry with no matching collector record falls back to producer 'command'", async () => {
        const registry = createBusArtifactRegistry();
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [entry("output/orphan.csv", "sha256:xyz", 5)],
            collector: fakeCollector([]),
        };

        await registry.register(input, noSession);

        const file = captured.find((e) => e.type === "prov.file_written");
        if (file?.type !== "prov.file_written") throw new Error("expected a file_written event");
        expect(file.file.producer).toBe("command");
    });

    test("a hash-less entry fails registration without emitting, while its siblings still emit", async () => {
        const registry = createBusArtifactRegistry();
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            // Middle entry has no hash (empty string counts as missing).
            artifacts: [entry("output/ok1.csv", "sha256:aaa", 10), entry("output/bad.csv", "", 20), entry("output/ok2.csv", "sha256:ccc", 30)],
            collector: fakeCollector([]),
        };

        const result = await registry.register(input, noSession);

        // Two files (the hash-less one is skipped, not emitted); no step event.
        expect(captured.map((e) => e.type)).toEqual(["prov.file_written", "prov.file_written"]);
        const emittedPaths = captured.filter((e) => e.type === "prov.file_written").map((e) => (e.type === "prov.file_written" ? e.file.path : ""));
        expect(emittedPaths).toEqual(["runs/run-001/de-analysis/output/ok1.csv", "runs/run-001/de-analysis/output/ok2.csv"]);

        expect(result.registered.map((r) => r.path)).toEqual(["runs/run-001/de-analysis/output/ok1.csv", "runs/run-001/de-analysis/output/ok2.csv"]);
        expect(result.failedCount).toBe(1);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]!.path).toBe("runs/run-001/de-analysis/output/bad.csv");
        expect(result.failed[0]!.error).toContain("content hash");
    });

    test("a hash-less tracked input fails registration without emitting, while its siblings still emit", async () => {
        const registry = createBusArtifactRegistry();
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [],
            // Middle input has no hash — an upstream attestation defect; the others still emit.
            collector: fakeCollector(
                [],
                [
                    { path: "/an-1/data/inputs/ok.csv", hash: "sha256:ok", source: "data" },
                    { path: "/an-1/data/inputs/bad.csv", hash: "", source: "data" },
                    { path: "/an-1/runs/run-000/step-x/output/prior.csv", hash: "sha256:pr", source: "prior" },
                ],
            ),
        };

        const result = await registry.register(input, noSession);

        expect(captured.map((e) => e.type)).toEqual(["prov.input_used", "prov.input_used"]);
        const emittedPaths = captured.filter((e) => e.type === "prov.input_used").map((e) => (e.type === "prov.input_used" ? e.input.path : ""));
        expect(emittedPaths).toEqual(["data/inputs/ok.csv", "runs/run-000/step-x/output/prior.csv"]);

        // The hash-less input fails registration (analysis-relative path), incrementing failedCount.
        expect(result.failedCount).toBe(1);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]!.path).toBe("data/inputs/bad.csv");
        expect(result.failed[0]!.error).toContain("content hash");
        expect(result.registered).toEqual([]);
    });

    test("a zero-entry, zero-input step emits nothing and returns empty arrays", async () => {
        const registry = createBusArtifactRegistry();
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [],
            collector: fakeCollector([]),
        };

        const result = await registry.register(input, noSession);

        expect(captured).toEqual([]);
        expect(result).toEqual({ registered: [], failed: [], failedCount: 0 });
    });
});

describe("createRunProvenanceEmitter", () => {
    test("run_started maps to prov.run_started, passing startedAtMs through from atMs", () => {
        const emit = createRunProvenanceEmitter();
        const event: RunProvenanceEvent = {
            type: "run_started",
            analysisId: "an-1",
            runId: "run-001",
            planSummary: "Profile the dataset",
            stepCount: 3,
            atMs: 1_700_000_000_000,
        };

        emit(event);

        expect(captured).toHaveLength(1);
        const busEvent = captured[0]!;
        if (busEvent.type !== "prov.run_started") throw new Error("expected prov.run_started");
        expect(busEvent.analysisId).toBe("an-1");
        expect(busEvent.actor.kind).toBe("system");
        // startedAtMs is the harness's atMs verbatim — no clock read in the mapping.
        expect(busEvent.run).toEqual({ runId: "run-001", planSummary: "Profile the dataset", startedAtMs: 1_700_000_000_000 });
    });

    test("step_completed maps to prov.step_completed, passing completedAtMs + durationMs through", () => {
        const emit = createRunProvenanceEmitter();
        const event: RunProvenanceEvent = {
            type: "step_completed",
            analysisId: "an-1",
            runId: "run-001",
            stepId: "step-de",
            status: "failed",
            durationMs: 90_000,
            atMs: 1_700_000_123_000,
        };

        emit(event);

        expect(captured).toHaveLength(1);
        const busEvent = captured[0]!;
        if (busEvent.type !== "prov.step_completed") throw new Error("expected prov.step_completed");
        expect(busEvent.analysisId).toBe("an-1");
        expect(busEvent.actor.kind).toBe("system");
        expect(busEvent.outcome).toEqual({ runId: "run-001", stepId: "step-de", status: "failed", completedAtMs: 1_700_000_123_000, durationMs: 90_000 });
    });

    test("step_completed with no durationMs leaves it unset in the outcome", () => {
        const emit = createRunProvenanceEmitter();
        // The child-error settlement branch carries no durable duration.
        const event: RunProvenanceEvent = {
            type: "step_completed",
            analysisId: "an-1",
            runId: "run-001",
            stepId: "step-err",
            status: "failed",
            atMs: 1_700_000_200_000,
        };

        emit(event);

        const busEvent = captured[0]!;
        if (busEvent.type !== "prov.step_completed") throw new Error("expected prov.step_completed");
        expect(busEvent.outcome).toEqual({ runId: "run-001", stepId: "step-err", status: "failed", completedAtMs: 1_700_000_200_000 });
        expect(busEvent.outcome.durationMs).toBeUndefined();
    });

    test("run_completed maps to prov.run_completed, passing completedAtMs + durationMs through", () => {
        const emit = createRunProvenanceEmitter();
        const event: RunProvenanceEvent = {
            type: "run_completed",
            analysisId: "an-1",
            runId: "run-001",
            status: "completed",
            atMs: 1_700_000_300_000,
            durationMs: 300_000,
        };

        emit(event);

        expect(captured).toHaveLength(1);
        const busEvent = captured[0]!;
        if (busEvent.type !== "prov.run_completed") throw new Error("expected prov.run_completed");
        expect(busEvent.analysisId).toBe("an-1");
        expect(busEvent.actor.kind).toBe("system");
        expect(busEvent.outcome).toEqual({ runId: "run-001", status: "completed", completedAtMs: 1_700_000_300_000, durationMs: 300_000 });
    });
});
