import { describe, expect, test } from "bun:test";
import { ProvenanceCollector } from "../collector.js";
import type { AgentSession } from "../../auth/types.js";
import type { ArtifactManifestEntry } from "../../schemas/artifact-manifest.js";
import { createProvDocumentModel } from "./document.js";
import { createProvenanceArtifactRegistry, createRunProvenanceEmitter } from "./bridge.js";
import type { ProvActor, ProvEvent } from "./types.js";

const actor: ProvActor = { kind: "system", label: "test-host", version: "0.0.0" };
const session = undefined as unknown as AgentSession;

function entry(path: string, hash: string | undefined, type: ArtifactManifestEntry["type"]): ArtifactManifestEntry {
    return { stepId: "s1", runId: "r1", path, size: 10, type, ...(hash !== undefined ? { hash } : {}) } as ArtifactManifestEntry;
}

function makeBridge() {
    const events: ProvEvent[] = [];
    const documentModel = createProvDocumentModel();
    const registry = createProvenanceArtifactRegistry({
        emit: (e) => events.push(e),
        actor: () => actor,
        model: "anthropic/test-model",
        documentModel,
    });
    return { events, documentModel, registry };
}

describe("provenance artifact-registry bridge", () => {
    test("producer groups emit declaration-before-reference; leaves fall to the step; inputs register", async () => {
        const { events, documentModel, registry } = makeBridge();
        const collector = new ProvenanceCollector({ stepId: "s1", runId: "r1", dependsOn: [] });
        collector.trackInputAccess("/res1", "data/inputs/counts.csv", "sha256:aaa", { source: "data" });
        collector.recordCommandExecution(
            "python run.py",
            [],
            0,
            1200,
            [
                { path: "output/result.csv", hash: "sha256:bbb", size: 10 },
                { path: "scripts/run.py", hash: "sha256:ccc", size: 5 },
            ],
            "scripts/run.py",
        );

        const artifacts = [
            entry("output/result.csv", "sha256:bbb", "output"),
            entry("scripts/run.py", "sha256:ccc", "script"),
            entry("logs/run.log", "sha256:ddd", "log"),
        ];
        const result = await registry.register({ resourceId: "res1", runId: "r1", stepId: "s1", artifacts, collector }, session);

        expect(result.failedCount).toBe(0);
        expect(events.map((e) => e.type)).toEqual(["command_executed", "file_written", "file_written", "file_written", "input_used"]);

        const command = events[0]!;
        if (command.type !== "command_executed" || command.command.kind !== "command") throw new Error("expected a command event");
        expect(command.command.scriptPath).toBe("runs/r1/s1/scripts/run.py");
        expect(command.command.inputs).toEqual([{ path: "data/inputs/counts.csv", hash: "sha256:aaa", source: "data" }]);
        expect(command.command.outputs.map((o) => o.path).sort()).toEqual(["runs/r1/s1/output/result.csv", "runs/r1/s1/scripts/run.py"]);
        expect(command.model).toBe("anthropic/test-model");

        const generations = events.filter((e) => e.type === "file_written").map((e) => (e.type === "file_written" ? e.generation : ""));
        expect(generations).toEqual(["command", "command", "step"]);

        const used = events[4]!;
        if (used.type !== "input_used") throw new Error("expected an input_used event");
        expect(used.input).toMatchObject({ path: "data/inputs/counts.csv", hash: "sha256:aaa", source: "data" });

        expect(result.registered.map((r) => r.externalId).sort()).toEqual(
            [
                documentModel.fileQName({ path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" }),
                documentModel.fileQName({ path: "runs/r1/s1/scripts/run.py", hash: "sha256:ccc" }),
                documentModel.fileQName({ path: "runs/r1/s1/logs/run.log", hash: "sha256:ddd" }),
            ].sort(),
        );
    });

    test("a step's own artifacts read resolves to a command-scoped step input keyed on the surviving hash", async () => {
        const { events, registry } = makeBridge();
        const collector = new ProvenanceCollector({ stepId: "s1", runId: "r1", dependsOn: [] });
        const selfRead = collector.trackInputAccess("/res1", "runs/r1/s1/output/first.csv", "sha256:stale", {
            source: "artifacts",
            stepId: "s1",
            runId: "r1",
        });
        collector.recordCommandExecution("python a.py", [], 0, 100, [{ path: "output/first.csv", hash: "sha256:v2", size: 4 }]);
        collector.recordCommandExecution("python b.py", [], 0, 100, [{ path: "output/second.csv", hash: "sha256:eee", size: 4 }], undefined, [selfRead!]);

        const artifacts = [entry("output/first.csv", "sha256:v2", "output"), entry("output/second.csv", "sha256:eee", "output")];
        const result = await registry.register({ resourceId: "res1", runId: "r1", stepId: "s1", artifacts, collector }, session);

        expect(result.failedCount).toBe(0);
        const commandB = events.find((e) => e.type === "command_executed" && e.command.kind === "command" && e.command.command === "python b.py");
        if (!commandB || commandB.type !== "command_executed" || commandB.command.kind !== "command") throw new Error("expected command b");
        // Keyed on the surviving registered hash (v2), not the stale read-time hash.
        expect(commandB.command.inputs).toEqual([{ path: "runs/r1/s1/output/first.csv", hash: "sha256:v2", source: "step" }]);
        // The step-level loop skips the artifacts self-read entirely.
        expect(events.filter((e) => e.type === "input_used").length).toBe(0);
    });

    test("hash-less entries and hash-less input refs fail fast and emit nothing", async () => {
        const { events, registry } = makeBridge();
        const collector = new ProvenanceCollector({ stepId: "s1", runId: "r1", dependsOn: [] });
        collector.trackInputAccess("/res1", "data/inputs/unattested.csv", null, { source: "data" });

        const artifacts = [entry("output/hashless.csv", undefined, "output")];
        const result = await registry.register({ resourceId: "res1", runId: "r1", stepId: "s1", artifacts, collector }, session);

        expect(result.registered).toEqual([]);
        expect(result.failedCount).toBe(2);
        expect(result.failed.map((f) => f.path).sort()).toEqual(["data/inputs/unattested.csv", "runs/r1/s1/output/hashless.csv"]);
        expect(events).toEqual([]);
    });
});

describe("run provenance emitter", () => {
    test("the three lifecycle arms map with checkpointed timestamps passed through", () => {
        const events: ProvEvent[] = [];
        const emitter = createRunProvenanceEmitter({ emit: (e) => events.push(e), actor: () => actor, model: "anthropic/test-model" });

        emitter({ type: "run_started", analysisId: "a1", runId: "r1", planSummary: "plan", stepCount: 2, atMs: 1000 });
        emitter({ type: "step_completed", analysisId: "a1", runId: "r1", stepId: "s1", status: "completed", durationMs: 50, atMs: 2000 });
        emitter({ type: "run_completed", analysisId: "a1", runId: "r1", status: "completed", atMs: 3000, durationMs: 2000 });

        expect(events).toEqual([
            { type: "run_started", analysisId: "a1", actor, run: { runId: "r1", planSummary: "plan", startedAtMs: 1000 } },
            {
                type: "step_completed",
                analysisId: "a1",
                actor,
                model: "anthropic/test-model",
                outcome: { runId: "r1", stepId: "s1", status: "completed", completedAtMs: 2000, durationMs: 50 },
            },
            {
                type: "run_completed",
                analysisId: "a1",
                actor,
                outcome: { runId: "r1", status: "completed", completedAtMs: 3000, durationMs: 2000 },
            },
        ]);
    });
});

describe("injected digest", () => {
    test("a custom digest re-derives every QName consistently, bridge externalIds included", async () => {
        const custom = createProvDocumentModel({ digest: (s) => `x${s.length.toString(36)}` });
        const fallback = createProvDocumentModel();
        const key = { path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" };
        expect(custom.fileQName(key)).not.toBe(fallback.fileQName(key));
        expect(custom.fileQName(key)).toBe(custom.fileQName({ ...key }));

        const events: ProvEvent[] = [];
        const registry = createProvenanceArtifactRegistry({
            emit: (e) => events.push(e),
            actor: () => actor,
            model: "anthropic/test-model",
            documentModel: custom,
        });
        const collector = new ProvenanceCollector({ stepId: "s1", runId: "r1", dependsOn: [] });
        collector.recordCommandExecution("python run.py", [], 0, 100, [{ path: "output/result.csv", hash: "sha256:bbb", size: 4 }]);
        const result = await registry.register(
            { resourceId: "res1", runId: "r1", stepId: "s1", artifacts: [entry("output/result.csv", "sha256:bbb", "output")], collector },
            session,
        );
        expect(result.registered).toEqual([{ path: "runs/r1/s1/output/result.csv", externalId: custom.fileQName(key) }]);
    });
});
