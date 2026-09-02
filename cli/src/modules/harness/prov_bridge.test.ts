import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "bun";
import type { AgentSession, ArtifactManifestEntry, ArtifactRegistrationInput, ProvenanceCollector, RunProvenanceEvent } from "@inflexa-ai/harness";
import { attestationSchema, verifyAttestation } from "@inflexa-ai/prov-kernel";

import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { getAnalysisProvenance } from "../../db/primary_query.ts";
import { Bus } from "../../lib/bus.ts";
import { asStr256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { ProvModelId } from "../../types/prov.ts";
import { provModel } from "../prov/document.ts";
import { flushProvenanceAsync, initProvenanceRecording, resetProvenanceRecorderForTests } from "../prov/prov.ts";
import { resetSigningForTests } from "../prov/signing.ts";

const { fileQName } = provModel;
import {
    createBusArtifactRegistry,
    createProvenanceSeam,
    createRunProvenanceEmitter,
    createSessionEmit,
    createSwappableSandboxEmitters,
    installProvenanceSeam,
    provenanceSeam,
    readProvenanceExport,
} from "./prov_bridge.ts";

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

// The input/record shapes the adapter reads off the collector — the subset of the harness's
// `InputRef`/`ProvenanceRecord` the adapter touches. Neither is re-exported from the barrel, and the `as
// unknown as` stub below never needs the full shape, so these structural mirrors are honest.
type FakeInputRef = { path: string; hash: string; source: "data" | "upstream" | "prior" | "artifacts"; fileId?: string };
type FakeProducer =
    | { type: "command"; command: string; args?: string[]; exitCode: number; durationMs: number; timestamp: string }
    | { type: "file_tool"; tool: string; invocationId: string };
type FakeRecord = { outputPath: string; producer: FakeProducer; inputs?: FakeInputRef[]; scriptPath?: string | null };

// The adapter reads `getRecords()` (→ full `{outputPath, producer, inputs, scriptPath}`) and
// `getTrackedInputs()` off the collector, so a structural stub of those two methods is cleaner than
// instantiating the real class (whose private fields would reject an object literal and whose ingest
// methods need write fixtures). The `as unknown as` bridges the private-member gap the adapter never
// touches. `producer` is passed through by REFERENCE so a test can form a command group by sharing one
// producer object across several records — exactly how the real collector keys a multi-output command.
function fakeCollector(records: FakeRecord[], trackedInputs: FakeInputRef[] = []): ProvenanceCollector {
    const recs = records.map((r) => ({ outputPath: r.outputPath, producer: r.producer, inputs: r.inputs ?? [], scriptPath: r.scriptPath ?? null }));
    return { getRecords: () => recs, getTrackedInputs: () => trackedInputs } as unknown as ProvenanceCollector;
}

type FileEvent = Extract<StampedEvent, { type: "prov.file_written" }>;
type CommandEvent = Extract<StampedEvent, { type: "prov.command_executed" }>;
type InputEvent = Extract<StampedEvent, { type: "prov.input_used" }>;
const commandEvents = (): CommandEvent[] => captured.filter((e): e is CommandEvent => e.type === "prov.command_executed");
const fileEvents = (): FileEvent[] => captured.filter((e): e is FileEvent => e.type === "prov.file_written");
const inputEvents = (): InputEvent[] => captured.filter((e): e is InputEvent => e.type === "prov.input_used");

// The bus adapter addresses no external system, so it ignores the session entirely — an empty stand-in
// is honest here (the adapter never dereferences it).
const noSession = {} as unknown as AgentSession;

// The construction-time {provider}/{model} name both bridge halves stamp onto their model-driven events.
const modelId: ProvModelId = "anthropic/claude-test";

function entry(path: string, hash: string | undefined, size: number): ArtifactManifestEntry {
    return { stepId: "de-analysis", runId: "run-001", path, size, type: "output", hash };
}

describe("createBusArtifactRegistry — register", () => {
    test("two entries sharing one producer group into a single command event carrying both outputs", async () => {
        const registry = createBusArtifactRegistry(modelId);
        // One producer OBJECT shared across both records — the collector's shape for a multi-output command.
        const cmd: FakeProducer = {
            type: "command",
            command: "python3 de.py",
            args: ["--threshold", "0.05"],
            exitCode: 0,
            durationMs: 1200,
            timestamp: "2026-07-06T00:00:00Z",
        };
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [entry("output/de_results.csv", "sha256:aaa", 10), entry("figures/heatmap.png", "sha256:bbb", 20)],
            collector: fakeCollector([
                { outputPath: "output/de_results.csv", producer: cmd },
                { outputPath: "figures/heatmap.png", producer: cmd },
            ]),
        };

        const result = await registry.register(input, noSession);

        // One command event, then its two file events (declaration-before-reference order).
        expect(captured.map((e) => e.type)).toEqual(["prov.command_executed", "prov.file_written", "prov.file_written"]);

        const cmds = commandEvents();
        expect(cmds).toHaveLength(1);
        const ref = cmds[0]!.command;
        if (ref.kind !== "command") throw new Error("expected a command-kind ref");
        expect(ref.command).toBe("python3 de.py");
        expect(ref.args).toEqual(["--threshold", "0.05"]);
        expect(ref.exitCode).toBe(0);
        expect(ref.durationMs).toBe(1200);
        expect(ref.inputs).toEqual([]);
        // Outputs are the analysis-scoped (path, hash) keys — identical to what the file events carry.
        expect(ref.outputs).toEqual([
            { path: "runs/run-001/de-analysis/output/de_results.csv", hash: "sha256:aaa" },
            { path: "runs/run-001/de-analysis/figures/heatmap.png", hash: "sha256:bbb" },
        ]);
        // The producer's replay-unstable observation timestamp NEVER crosses the bus.
        expect(JSON.stringify(cmds[0]!)).not.toContain("timestamp");
        expect(cmds[0]!.step).toEqual({ runId: "run-001", stepId: "de-analysis" });
        expect(cmds[0]!.actor.kind).toBe("system");
        // The construction-time model id rides the event — which model drove the producing step.
        expect(cmds[0]!.model).toBe(modelId);

        // Every produced file rides generation "command" — the command activity owns the generation edge.
        const files = fileEvents();
        expect(files.map((f) => f.generation)).toEqual(["command", "command"]);
        expect(files.map((f) => f.file.producer)).toEqual(["command", "command"]);
        // The construction-time model id and the step ref ride every file event.
        expect(files.map((f) => f.model)).toEqual([modelId, modelId]);
        expect(files.map((f) => f.step)).toEqual([
            { runId: "run-001", stepId: "de-analysis" },
            { runId: "run-001", stepId: "de-analysis" },
        ]);
        // Both files register with their QN externalIds and nothing failed — a clean, fully-attested result.
        expect(result.failedCount).toBe(0);
        expect(result.failed).toEqual([]);
        expect(result.registered).toEqual(files.map((f) => ({ path: f.file.path, externalId: fileQName(f.file) })));
    });

    test("a file-tool write emits a call-generation file event and no command event", async () => {
        const registry = createBusArtifactRegistry(modelId);
        const tool: FakeProducer = { type: "file_tool", tool: "write_file", invocationId: "call-9" };
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [entry("output/summary.md", "sha256:sss", 42)],
            collector: fakeCollector([{ outputPath: "output/summary.md", producer: tool }]),
        };

        const result = await registry.register(input, noSession);

        // No pseudo-command exists for a file-tool write — the call ref rides the file event and the
        // kernel mints the deterministic call activity from it.
        expect(captured.map((e) => e.type)).toEqual(["prov.file_written"]);
        const file = fileEvents()[0]!;
        expect(file.generation).toBe("call");
        expect(file.call).toEqual({ invocationId: "call-9", tool: "write_file" });
        expect(file.step).toEqual({ runId: "run-001", stepId: "de-analysis" });
        expect(file.model).toBe(modelId);
        expect(file.file.producer).toBe("file_tool");
        expect(file.file.path).toBe("runs/run-001/de-analysis/output/summary.md");
        // The write still registers with its deterministic file QName.
        expect(result.registered).toEqual([{ path: file.file.path, externalId: fileQName(file.file) }]);
    });

    test("a leaf entry (no collector record) emits no command event and keeps step generation", async () => {
        const registry = createBusArtifactRegistry(modelId);
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [entry("output/orphan.csv", "sha256:xyz", 5)],
            collector: fakeCollector([]),
        };

        await registry.register(input, noSession);

        // No command activity references a leaf; only the file event fires.
        expect(captured.map((e) => e.type)).toEqual(["prov.file_written"]);
        const file = fileEvents()[0]!;
        // Its generation falls to the step activity; the inotify-only fallback producer is "command".
        expect(file.generation).toBe("step");
        expect(file.file.producer).toBe("command");
        expect(file.step).toEqual({ runId: "run-001", stepId: "de-analysis" });
        expect(file.model).toBe(modelId);
    });

    test("an intra-step artifacts read resolves to a command-scoped 'step' input, while a phantom self-read is dropped", async () => {
        const registry = createBusArtifactRegistry(modelId);
        const cmdA: FakeProducer = { type: "command", command: "python3 de.py", exitCode: 0, durationMs: 900, timestamp: "t" };
        const cmdB: FakeProducer = { type: "command", command: "python3 plot.py", exitCode: 0, durationMs: 300, timestamp: "t" };
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            // de_results.csv is produced by cmdA and read by cmdB; tmp.csv is read by cmdB but is NOT in the
            // manifest (a written-then-deleted phantom). Record read paths arrive container-absolute.
            artifacts: [entry("output/de_results.csv", "sha256:aaa", 10), entry("figures/heatmap.png", "sha256:bbb", 20)],
            collector: fakeCollector([
                { outputPath: "output/de_results.csv", producer: cmdA },
                {
                    outputPath: "figures/heatmap.png",
                    producer: cmdB,
                    inputs: [
                        { path: "/an-1/runs/run-001/de-analysis/output/de_results.csv", hash: "sha256:aaa", source: "artifacts" },
                        { path: "/an-1/runs/run-001/de-analysis/output/tmp.csv", hash: "sha256:tmp", source: "artifacts" },
                    ],
                },
            ]),
        };

        await registry.register(input, noSession);

        // cmdA's group first (command then its file), then cmdB's group (command then its file).
        expect(captured.map((e) => e.type)).toEqual(["prov.command_executed", "prov.file_written", "prov.command_executed", "prov.file_written"]);

        const cmdBRef = commandEvents()[1]!.command;
        if (cmdBRef.kind !== "command") throw new Error("expected a command-kind ref");
        // The self-read of the produced de_results.csv resolves to its analysis-scoped path as source
        // "step"; the phantom tmp.csv (absent from the manifest) appears nowhere — no dangling edge.
        expect(cmdBRef.inputs).toEqual([{ path: "runs/run-001/de-analysis/output/de_results.csv", hash: "sha256:aaa", source: "step" }]);
        // And it keys onto the very entity cmdA's output registered.
        expect(fileQName(cmdBRef.inputs[0]!)).toBe(fileQName({ path: "runs/run-001/de-analysis/output/de_results.csv", hash: "sha256:aaa" }));
    });

    test("a step-relative scriptPath is scoped to the analysis output space so the builder can resolve it", async () => {
        const registry = createBusArtifactRegistry(modelId);
        const cmd: FakeProducer = { type: "command", command: "python3 scripts/de.py", exitCode: 0, durationMs: 500, timestamp: "t" };
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [entry("output/de_results.csv", "sha256:aaa", 10)],
            collector: fakeCollector([{ outputPath: "output/de_results.csv", producer: cmd, scriptPath: "scripts/de.py" }]),
        };

        await registry.register(input, noSession);

        const ref = commandEvents()[0]!.command;
        if (ref.kind !== "command") throw new Error("expected a command-kind ref");
        // Step-relative `scripts/de.py` is scoped into the analysis path space the outputs live in.
        expect(ref.scriptPath).toBe("runs/run-001/de-analysis/scripts/de.py");
    });

    test("step-level input_used passes non-artifacts reads through and still skips the step's own artifacts reads", async () => {
        const registry = createBusArtifactRegistry(modelId);
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [],
            collector: fakeCollector(
                [],
                // Three non-artifacts reads (one per classification) + one `artifacts` read (the step's own
                // output) that the step-level registry MUST skip. Paths are container-absolute.
                [
                    { path: "/an-1/data/inputs/raw.csv", hash: "sha256:d1", source: "data", fileId: "file-1" },
                    { path: "/an-1/runs/run-001/step-up/output/up.csv", hash: "sha256:u1", source: "upstream" },
                    { path: "/an-1/runs/run-000/step-de/output/results.csv", hash: "sha256:p1", source: "prior" },
                    { path: "/an-1/runs/run-001/de-analysis/output/self.csv", hash: "sha256:s1", source: "artifacts" },
                ],
            ),
        };

        await registry.register(input, noSession);

        // Only the three non-artifacts reads emit; the `artifacts` read is skipped; no other events.
        expect(captured.map((e) => e.type)).toEqual(["prov.input_used", "prov.input_used", "prov.input_used"]);
        const inputs = inputEvents();
        // Container mount prefix stripped to analysis-relative; hash + source pass through; fileId only
        // when present; each carries the pure step ref.
        expect(inputs.map((i) => i.input.path)).toEqual([
            "data/inputs/raw.csv",
            "runs/run-001/step-up/output/up.csv",
            "runs/run-000/step-de/output/results.csv",
        ]);
        expect(inputs.map((i) => i.input.source)).toEqual(["data", "upstream", "prior"]);
        expect(inputs.map((i) => i.input.hash)).toEqual(["sha256:d1", "sha256:u1", "sha256:p1"]);
        expect(inputs.map((i) => i.input.fileId)).toEqual(["file-1", undefined, undefined]);
        for (const i of inputs) {
            expect(i.analysisId).toBe("an-1");
            expect(i.actor.kind).toBe("system");
            expect(i.step).toEqual({ runId: "run-001", stepId: "de-analysis" });
        }
    });

    test("a prior read strips to the SAME analysis-relative path the producing run's file event used", async () => {
        const registry = createBusArtifactRegistry(modelId);
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
        // fileQName resolves both to one entity — the match that chains lineage across runs.
        expect(inputEvent.input.path).toBe("runs/run-001/step-de/output/results.csv");
        expect(fileQName(inputEvent.input)).toBe(fileQName({ path: "runs/run-001/step-de/output/results.csv", hash: "sha256:same" }));
    });

    test("a hash-less entry fails registration without emitting, while its siblings still emit", async () => {
        const registry = createBusArtifactRegistry(modelId);
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
        const registry = createBusArtifactRegistry(modelId);
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
        const registry = createBusArtifactRegistry(modelId);
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
        const emit = createRunProvenanceEmitter(modelId);
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
        const emit = createRunProvenanceEmitter(modelId);
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
        // The construction-time model id rides the event — which model drove the step.
        expect(busEvent.model).toBe(modelId);
    });

    test("step_completed with no durationMs leaves it unset in the outcome", () => {
        const emit = createRunProvenanceEmitter(modelId);
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

    test("the construction-time model id is stamped verbatim — an arbitrary configured provider, no sniffing path", () => {
        // A direct connection's `{provider}/{model}` for a provider no family table knows: the bridge
        // stamps exactly what boot composed from the configured slug + resolved id — there is no
        // derivation anywhere that could turn `some-alias-v2` into `deepseek`.
        const emit = createRunProvenanceEmitter("deepseek/some-alias-v2");
        const event: RunProvenanceEvent = {
            type: "step_completed",
            analysisId: "an-1",
            runId: "run-1",
            stepId: "step-de",
            status: "completed",
            atMs: 1_700_000_400_000,
        };

        emit(event);

        const busEvent = captured[0]!;
        if (busEvent.type !== "prov.step_completed") throw new Error("expected prov.step_completed");
        expect(busEvent.model).toBe("deepseek/some-alias-v2");
    });

    test("run_completed maps to prov.run_completed, passing completedAtMs + durationMs through", () => {
        const emit = createRunProvenanceEmitter(modelId);
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

describe("createSwappableSandboxEmitters", () => {
    type StepEvent = Extract<StampedEvent, { type: "prov.step_completed" }>;
    const stepModels = (): string[] => captured.filter((e): e is StepEvent => e.type === "prov.step_completed").map((e) => e.model);

    // A step_completed event carrying an ascending `atMs` so successive emits stay distinguishable.
    function stepAt(atMs: number): RunProvenanceEvent {
        return { type: "step_completed", analysisId: "an-1", runId: "run-1", stepId: "step-1", status: "completed", atMs };
    }
    // One command-producing registration input — its `prov.command_executed` carries the stamped model.
    function commandInput(): ArtifactRegistrationInput {
        const cmd: FakeProducer = { type: "command", command: "python3 de.py", exitCode: 0, durationMs: 100, timestamp: "t" };
        return {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [entry("output/de.csv", "sha256:aaa", 10)],
            collector: fakeCollector([{ outputPath: "output/de.csv", producer: cmd }]),
        };
    }

    test("emitProvenance stamps the pre-swap name, then the post-swap name, through ONE captured function reference", () => {
        const emitters = createSwappableSandboxEmitters("anthropic/claude-old");
        // Snapshot the handle exactly as a registration-time consumer would — the worst case for a swap.
        const emit = emitters.emitProvenance;

        emit(stepAt(1));
        emitters.swap("anthropic/claude-new");
        emit(stepAt(2));

        // The captured reference stamped the old name before the swap and the new name after — the swap
        // re-pointed the inner behind the stable handle, not the handle the consumer holds.
        expect(stepModels()).toEqual(["anthropic/claude-old", "anthropic/claude-new"]);
    });

    test("artifactRegistry forwards register to the current inner across a swap, through ONE captured object reference", async () => {
        const emitters = createSwappableSandboxEmitters("anthropic/claude-old");
        const registry = emitters.artifactRegistry;

        await registry.register(commandInput(), noSession);
        emitters.swap("anthropic/claude-new");
        await registry.register(commandInput(), noSession);

        expect(commandEvents().map((c) => c.model)).toEqual(["anthropic/claude-old", "anthropic/claude-new"]);
    });

    test("swap leaves the outer emitProvenance function and artifactRegistry object identities unchanged", () => {
        const emitters = createSwappableSandboxEmitters("anthropic/claude-old");
        const emit = emitters.emitProvenance;
        const registry = emitters.artifactRegistry;

        emitters.swap("anthropic/claude-new");

        expect(emitters.emitProvenance).toBe(emit);
        expect(emitters.artifactRegistry).toBe(registry);
    });
});

const sessionModelId: ProvModelId = "anthropic/claude-sonnet-4-5";
const sessionAnalysisId = "analysis-1";
const reportThreadId = "thread-report-1";

/** The single captured event, or a test failure when the bridge emitted none or more than one. */
function onlyEvent(): StampedEvent {
    expect(captured.length).toBe(1);
    return captured[0]!;
}

// The emit over a fixed model name — the shape every mapping test drives, except the live-switch one
// below, which builds its own emit over a source that changes.
const emitSession = createSessionEmit(() => sessionModelId);

describe("createSessionEmit", () => {
    test("a created report session carries the thread, the kind, and the parent", () => {
        emitSession({
            type: "create-session",
            analysisId: sessionAnalysisId,
            threadId: reportThreadId,
            sessionKind: "report",
            parentThreadId: "thread-conv-1",
        });

        const event = onlyEvent();
        if (event.type !== "prov.session_created") throw new Error(`expected prov.session_created, got ${event.type}`);
        expect(event.analysisId).toBe(sessionAnalysisId);
        expect(event.session).toEqual({ threadId: reportThreadId, kind: "report", parentThreadId: "thread-conv-1" });
    });

    test("a created conversation session carries its kind and no parent key", () => {
        emitSession({ type: "create-session", analysisId: sessionAnalysisId, threadId: "thread-conv-1", sessionKind: "conversation" });

        const event = onlyEvent();
        if (event.type !== "prov.session_created") throw new Error("expected prov.session_created");
        expect(event.session.kind).toBe("conversation");
        // A root session has no parent, so the key is absent rather than present and undefined.
        expect("parentThreadId" in event.session).toBe(false);
    });

    test("each block act maps onto its own member and carries the kind of the block", () => {
        emitSession({ type: "add-block", analysisId: sessionAnalysisId, threadId: reportThreadId, blockId: "b1", blockKind: "text" });
        emitSession({ type: "change-block", analysisId: sessionAnalysisId, threadId: reportThreadId, blockId: "b2", blockKind: "chart" });
        emitSession({ type: "remove-block", analysisId: sessionAnalysisId, threadId: reportThreadId, blockId: "b3", blockKind: "table" });
        emitSession({ type: "move-block", analysisId: sessionAnalysisId, threadId: reportThreadId, blockId: "b4", blockKind: "figure" });

        expect(captured.map((e) => e.type)).toEqual([
            "prov.report_block_added",
            "prov.report_block_changed",
            "prov.report_block_removed",
            "prov.report_block_moved",
        ]);
        const kinds = captured.map((e) => (e.type.startsWith("prov.report_block_") && "block" in e ? e.block.blockKind : null));
        expect(kinds).toEqual(["text", "chart", "table", "figure"]);
        const moved = captured[3]!;
        if (moved.type !== "prov.report_block_moved") throw new Error("expected prov.report_block_moved");
        expect(moved.block).toEqual({ threadId: reportThreadId, blockId: "b4", blockKind: "figure" });
    });

    test("the title, the preview, and the version record carry the data of their act", () => {
        emitSession({ type: "set-title", analysisId: sessionAnalysisId, threadId: reportThreadId, title: "Differential expression" });
        emitSession({
            type: "preview",
            analysisId: sessionAnalysisId,
            threadId: reportThreadId,
            pagePath: "report-sessions/t/page.html",
            documentHash: "h-doc",
        });
        emitSession({ type: "record-version", analysisId: sessionAnalysisId, threadId: reportThreadId, versionId: "v1", replaced: true });

        const [title, preview, version] = captured;
        if (title?.type !== "prov.report_title_set") throw new Error("expected prov.report_title_set");
        expect(title.title).toEqual({ threadId: reportThreadId, title: "Differential expression" });
        if (preview?.type !== "prov.report_previewed") throw new Error("expected prov.report_previewed");
        expect(preview.preview).toEqual({ threadId: reportThreadId, pagePath: "report-sessions/t/page.html", documentHash: "h-doc" });
        if (version?.type !== "prov.report_version_recorded") throw new Error("expected prov.report_version_recorded");
        expect(version.version).toEqual({ threadId: reportThreadId, versionId: "v1", replaced: true });
    });

    test("a conversation file write maps onto a call-generation prov.file_written with no step", () => {
        emitSession({
            type: "write-file",
            analysisId: sessionAnalysisId,
            threadId: "thread-conv-1",
            path: "notes/summary.md",
            hash: "sha256:abc",
            size: 42,
            tool: "write_file",
            invocationId: "call-1",
        });

        const event = onlyEvent();
        if (event.type !== "prov.file_written") throw new Error(`expected prov.file_written, got ${event.type}`);
        expect(event.analysisId).toBe(sessionAnalysisId);
        expect(event.model).toBe(sessionModelId);
        expect(event.generation).toBe("call");
        expect(event.call).toEqual({ invocationId: "call-1", tool: "write_file", threadId: "thread-conv-1" });
        expect(event.file).toEqual({ path: "notes/summary.md", hash: "sha256:abc", size: 42, producer: "file_tool" });
        // A session write has no run and no step to anchor to.
        expect("step" in event).toBe(false);
    });

    test("a file write with no thread carries no threadId key on the call ref", () => {
        emitSession({
            type: "write-file",
            analysisId: sessionAnalysisId,
            path: "notes/a.md",
            hash: "sha256:aaa",
            size: 1,
            tool: "edit_file",
            invocationId: "call-2",
        });

        const event = onlyEvent();
        if (event.type !== "prov.file_written") throw new Error("expected prov.file_written");
        expect(event.call).toBeDefined();
        expect("threadId" in event.call!).toBe(false);
        expect(event.call!.tool).toBe("edit_file");
        expect(event.call!.invocationId).toBe("call-2");
    });

    test("a derivation carries its chain, restated pair by pair", () => {
        const sources = [
            { path: "data/inputs/f1/counts.csv", hash: "h1" },
            { path: "runs/r1/s1/output/de.csv", hash: "h2" },
        ];
        emitSession({
            type: "run-derivation",
            analysisId: sessionAnalysisId,
            threadId: reportThreadId,
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
        emitSession({ type: "add-block", analysisId: sessionAnalysisId, threadId: reportThreadId, blockId: "b1", blockKind: "text" });

        const event = onlyEvent();
        if (event.type !== "prov.report_block_added") throw new Error("expected prov.report_block_added");
        expect(event.actor.kind).toBe("system");
    });

    test("the model is read at emit time, so a live switch re-stamps the later acts", () => {
        let live: ProvModelId = "anthropic/claude-sonnet-4-5";
        const emitLive = createSessionEmit(() => live);

        emitLive({ type: "add-block", analysisId: sessionAnalysisId, threadId: reportThreadId, blockId: "b1", blockKind: "text" });
        live = "openai/gpt-5";
        emitLive({ type: "add-block", analysisId: sessionAnalysisId, threadId: reportThreadId, blockId: "b2", blockKind: "text" });

        const [first, second] = captured;
        if (first?.type !== "prov.report_block_added" || second?.type !== "prov.report_block_added") throw new Error("expected two block events");
        expect(first.model).toBe("anthropic/claude-sonnet-4-5");
        expect(second.model).toBe("openai/gpt-5");
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

describe("readProvenanceExport", () => {
    let tmpDir: string;

    beforeEach(() => {
        freshDb();
        resetProvenanceRecorderForTests();
        // A real keypair in a temp dir: the flush refuses to write unsigned bytes, so a test that reads
        // the column at all needs signing to succeed.
        tmpDir = join(tmpdir(), `prov-bridge-test-${randomUUIDv7()}`);
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

    test("a populated analysis gives the stored bytes and an attestation over them", async () => {
        emitSession({ type: "add-block", analysisId: "a1", threadId: reportThreadId, blockId: "b1", blockKind: "text" });
        await flushProvenanceAsync();

        const provenance = await readProvenanceExport("a1");
        expect(provenance).toBeDefined();
        // The exact bytes of the column, which are the bytes the chain hash covers.
        expect(provenance!.document).toBe(getAnalysisProvenance("a1")._unsafeUnwrap()!);
        const attestation = attestationSchema.parse(JSON.parse(provenance!.attestation!));
        expect((await verifyAttestation(provenance!.document, attestation)).status).toBe("valid");
    });

    test("the drain runs first, so a read gives the bytes that include the act", async () => {
        // The recorder writes the column on a debounced flush, and this read never awaits one itself.
        emitSession({ type: "record-version", analysisId: "a1", threadId: reportThreadId, versionId: "v-drain", replaced: false });

        const provenance = await readProvenanceExport("a1");
        expect(provenance).toBeDefined();
        expect(provenance!.document).toContain("v-drain");
    });

    test("an unknown analysis gives absence", async () => {
        expect(await readProvenanceExport("no-such-analysis")).toBeUndefined();
    });

    test("an analysis whose provenance column is null gives absence", async () => {
        // The row exists, and no act has flushed a document onto it.
        expect(getAnalysisProvenance("a1")._unsafeUnwrap()).toBeNull();

        expect(await readProvenanceExport("a1")).toBeUndefined();
    });

    test("a failed attestation build gives absence, and the document never reaches the page without its proof", async () => {
        emitSession({ type: "add-block", analysisId: "a1", threadId: reportThreadId, blockId: "b1", blockKind: "text" });
        await flushProvenanceAsync();
        expect(getAnalysisProvenance("a1")._unsafeUnwrap()).not.toBeNull();

        // A parseable key file that holds no importable key: the build of the attestation then fails
        // while the column still holds a document. The failure also reaches the log.
        const corruptPath = join(tmpDir, "corrupt_key.json");
        writeFileSync(corruptPath, JSON.stringify({ publicKey: {}, privateKey: {} }));
        resetSigningForTests(corruptPath);

        expect(await readProvenanceExport("a1")).toBeUndefined();
    });
});

describe("createProvenanceSeam", () => {
    afterEach(() => {
        installProvenanceSeam(null);
    });

    test("the seam binds the three members, and its run emit is the holder's stable handle", () => {
        const emitters = createSwappableSandboxEmitters("anthropic/claude-old");
        const seam = createProvenanceSeam({ emitters, sessionModel: () => "openai/gpt-5" });

        expect(seam.emitRunEvent).toBe(emitters.emitProvenance);
        expect(seam.readExport).toBe(readProvenanceExport);

        // The session emit is bound over the source that the constructor took, thus a record of an act
        // names the model of THIS seam and of no other.
        seam.emitSessionEvent!({ type: "add-block", analysisId: sessionAnalysisId, threadId: reportThreadId, blockId: "b1", blockKind: "text" });
        const event = onlyEvent();
        if (event.type !== "prov.report_block_added") throw new Error("expected prov.report_block_added");
        expect(event.model).toBe("openai/gpt-5");
    });

    test("the accessor gives the exact installed object, and a null install clears it", () => {
        const emitters = createSwappableSandboxEmitters("anthropic/claude-old");
        const seam = createProvenanceSeam({ emitters, sessionModel: () => sessionModelId });

        installProvenanceSeam(seam);
        // Reference equality is the whole point: the core bag, the run-engine deps, and the chat turn
        // read ONE object, thus a created session carries one claim whichever surface drives it.
        expect(provenanceSeam()).toBe(seam);

        installProvenanceSeam(null);
        expect(provenanceSeam()).toBeUndefined();
    });
});
