import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProvDocument } from "@inflexa-ai/tsprov";
import { buildDocumentModel, PROV_UNIFY_OPTIONS, type ProvDocumentModelInternal } from "./document.js";
import type { ProvActor, ProvModelId } from "./types.js";

/**
 * The golden document: a small, fully deterministic document built from fixed ids, fixed epoch-ms
 * timestamps, an injected fixed clock, and a counting action-id minter under the default digest,
 * compared BYTE-FOR-BYTE against the committed fixture. It guards cross-recorder drift — any
 * change to a QName derivation, a relation-id scheme, an attribute name, a time encoding, or the
 * unify semantics shows up here as a fixture diff, and an independent writer (e.g. a Go
 * implementation) can target the same fixture. Never uses `Date.now()` or a real clock.
 *
 * Deliberate coverage: the lifecycle builders and the generic lifecycle action, a user agent
 * (opaque id plus email), a resolved and an unresolved `scriptPath`, an empty `args` vector (no
 * `inflexa:args` attribute), the `file_tool` generation path, a plain-boolean `inflexa:isDir`, a
 * typed-int `inflexa:size`, and a non-zero-millisecond formal time.
 */

const user: ProvActor = { kind: "user", id: "u-42", email: "golden@example.com" };
const system: ProvActor = { kind: "system", label: "golden-host", version: "1.0.0", commit: "deadbeef" };
const model: ProvModelId = "anthropic/golden-model";

function makeModel(): ProvDocumentModelInternal {
    let actionN = 0;
    return buildDocumentModel({
        now: () => new Date(1_699_999_999_500),
        mintActionId: () => `golden-${++actionN}`,
    });
}

export function buildGoldenDocument(m: ProvDocumentModelInternal): ProvDocument {
    const doc = m.freshDocument({ analysisId: "a-golden", name: "Golden Analysis", slug: "golden-analysis" });
    const step = { runId: "r1", stepId: "s1" };
    m.appendCreation(doc, "a-golden", user);
    m.appendInputAdded(doc, "a-golden", user, { path: "data/inputs/counts.csv", isDir: false, anchorId: "anchor-1" }, null);
    m.appendLifecycleAction(doc, "a-golden", user, "inflexa:HostDefinedAction");
    m.appendRunStarted(doc, "a-golden", system, { runId: "r1", planSummary: "golden plan", startedAtMs: 1_700_000_000_000 });
    m.appendCommandExecuted(
        doc,
        "a-golden",
        system,
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
    m.appendCommandExecuted(
        doc,
        "a-golden",
        system,
        step,
        {
            kind: "command",
            command: "Rscript analyze.R",
            args: [],
            exitCode: 1,
            scriptPath: "runs/r1/s1/scripts/analyze.R",
            outputs: [{ path: "runs/r1/s1/output/plot.png", hash: "sha256:eee" }],
            inputs: [],
        },
        model,
    );
    m.appendCommandExecuted(
        doc,
        "a-golden",
        system,
        step,
        { kind: "file_tool", tool: "write_file", outputs: [{ path: "runs/r1/s1/output/notes.md", hash: "sha256:fff" }] },
        model,
    );
    m.appendFileWritten(doc, "a-golden", system, { path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb", size: 10, producer: "command" }, step, "command");
    m.appendFileWritten(doc, "a-golden", system, { path: "runs/r1/s1/logs/run.log", hash: "sha256:ddd", size: 3, producer: "command" }, step, "step");
    m.appendFileWritten(doc, "a-golden", system, { path: "runs/r1/s1/output/notes.md", hash: "sha256:fff", size: 7, producer: "file_tool" }, step, "command");
    m.appendInputUsed(doc, "a-golden", system, step, { path: "data/inputs/counts.csv", hash: "sha256:aaa", source: "data", fileId: "file-1" });
    m.appendStepCompleted(
        doc,
        "a-golden",
        system,
        { runId: "r1", stepId: "s1", status: "completed", completedAtMs: 1_700_000_100_123, durationMs: 100_000 },
        model,
    );
    m.appendRunCompleted(doc, "a-golden", system, { runId: "r1", status: "completed", completedAtMs: 1_700_000_200_000, durationMs: 200_000 });
    return doc;
}

describe("golden document", () => {
    test("the deterministic document serializes to the committed fixture bytes", () => {
        const json = buildGoldenDocument(makeModel()).unified(PROV_UNIFY_OPTIONS).serialize("json");
        const fixture = readFileSync(new URL("./__fixtures__/golden-document.json", import.meta.url), "utf8");
        expect(json).toBe(fixture);
    });

    test("building the document twice yields identical bytes", () => {
        const a = buildGoldenDocument(makeModel()).unified(PROV_UNIFY_OPTIONS).serialize("json");
        const b = buildGoldenDocument(makeModel()).unified(PROV_UNIFY_OPTIONS).serialize("json");
        expect(a).toBe(b);
    });
});
