import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentSession, ArtifactManifestEntry, ArtifactRegistrationInput, ProvenanceCollector, RunProvenanceEvent } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { ProvModelRef } from "../../types/prov.ts";
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

// The input/record shapes the adapter reads off the collector — the subset of the harness's
// `InputRef`/`ProvenanceRecord` the adapter touches. Neither is re-exported from the barrel, and the `as
// unknown as` stub below never needs the full shape, so these structural mirrors are honest.
type FakeInputRef = { path: string; hash: string; source: "data" | "upstream" | "prior" | "artifacts"; fileId?: string };
type FakeProducer =
    | { type: "command"; command: string; args?: string[]; exitCode: number; durationMs: number; timestamp: string }
    | { type: "file_tool"; tool: string; timestamp: string };
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

// The construction-time model ref both bridge halves stamp onto their model-driven events.
const modelRef: ProvModelRef = { provider: "anthropic", model: "claude-test" };

function entry(path: string, hash: string | undefined, size: number): ArtifactManifestEntry {
    return { stepId: "de-analysis", runId: "run-001", path, size, type: "output", hash };
}

describe("createBusArtifactRegistry — register", () => {
    test("two entries sharing one producer group into a single command event carrying both outputs", async () => {
        const registry = createBusArtifactRegistry(modelRef);
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
        // The producer's replay-unstable observation timestamp NEVER crosses the bus (design D1).
        expect(JSON.stringify(cmds[0]!)).not.toContain("timestamp");
        expect(cmds[0]!.step).toEqual({ runId: "run-001", stepId: "de-analysis" });
        expect(cmds[0]!.actor.kind).toBe("system");
        // The construction-time model ref rides the event — which model drove the producing step.
        expect(cmds[0]!.model).toEqual(modelRef);

        // Every produced file rides generation "command" — the command activity owns the generation edge.
        const files = fileEvents();
        expect(files.map((f) => f.generation)).toEqual(["command", "command"]);
        expect(files.map((f) => f.file.producer)).toEqual(["command", "command"]);
        // Both files register with their QN externalIds and nothing failed — a clean, fully-attested result.
        expect(result.failedCount).toBe(0);
        expect(result.failed).toEqual([]);
        expect(result.registered).toEqual(files.map((f) => ({ path: f.file.path, externalId: fileQName(f.file) })));
    });

    test("a file-tool write groups into a file_tool command event with no inputs", async () => {
        const registry = createBusArtifactRegistry(modelRef);
        const tool: FakeProducer = { type: "file_tool", tool: "write_file", timestamp: "2026-07-06T00:00:00Z" };
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-001",
            stepId: "de-analysis",
            artifacts: [entry("output/summary.md", "sha256:sss", 42)],
            collector: fakeCollector([{ outputPath: "output/summary.md", producer: tool }]),
        };

        await registry.register(input, noSession);

        expect(captured.map((e) => e.type)).toEqual(["prov.command_executed", "prov.file_written"]);
        const ref = commandEvents()[0]!.command;
        if (ref.kind !== "file_tool") throw new Error("expected a file_tool-kind ref");
        expect(ref.tool).toBe("write_file");
        expect(ref.outputs).toEqual([{ path: "runs/run-001/de-analysis/output/summary.md", hash: "sha256:sss" }]);
        // The file_tool variant carries no `inputs` field by construction (agent-authored content).
        expect("inputs" in ref).toBe(false);
        // The file event's producer joins from the record; its generation is the command's, not the step's.
        const file = fileEvents()[0]!;
        expect(file.file.producer).toBe("file_tool");
        expect(file.generation).toBe("command");
    });

    test("a leaf entry (no collector record) emits no command event and keeps step generation", async () => {
        const registry = createBusArtifactRegistry(modelRef);
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
    });

    test("an intra-step artifacts read resolves to a command-scoped 'step' input, while a phantom self-read is dropped", async () => {
        const registry = createBusArtifactRegistry(modelRef);
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
        const registry = createBusArtifactRegistry(modelRef);
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
        const registry = createBusArtifactRegistry(modelRef);
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
        const registry = createBusArtifactRegistry(modelRef);
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

    test("a hash-less entry fails registration without emitting, while its siblings still emit", async () => {
        const registry = createBusArtifactRegistry(modelRef);
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
        const registry = createBusArtifactRegistry(modelRef);
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
        const registry = createBusArtifactRegistry(modelRef);
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
        const emit = createRunProvenanceEmitter(modelRef);
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
        const emit = createRunProvenanceEmitter(modelRef);
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
        // The construction-time model ref rides the event — which model drove the step.
        expect(busEvent.model).toEqual(modelRef);
    });

    test("step_completed with no durationMs leaves it unset in the outcome", () => {
        const emit = createRunProvenanceEmitter(modelRef);
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
        const emit = createRunProvenanceEmitter(modelRef);
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
