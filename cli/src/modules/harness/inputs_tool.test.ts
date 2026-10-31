import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DETAIL_MAX_LENGTH, type AgentSession, type AskRequest, type ToolContext } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import { acquireInstanceLock, releaseInstanceLock } from "../../lib/lock.ts";
import { str256 } from "../../lib/types.ts";
import type { BusEvent } from "../../types/events.ts";
import { err } from "neverthrow";

import { insertAnalysisInput } from "../../db/primary_mutation.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { freshDb } from "../../test_support/db.ts";
import { createAnalysis, removeInput } from "../analysis/analysis.ts";
import { createManageInputsTool } from "./inputs_tool.ts";

/** A minimal `ToolContext` carrying the analysis scope the tool reads. */
function ctxFor(analysisId: string): ToolContext {
    return {
        // The tool reads only `session.scope`; a cast avoids constructing the full value object.
        session: { scope: { kind: "analysis", analysisId } } as unknown as AgentSession,
        invocationId: "test-tool-call",
        signal: new AbortController().signal,
        emit: () => {},
    };
}

/** The decision of a user that approves each request, and keeps the requests. */
function recordingAsk(): { fn: (r: AskRequest) => Promise<void>; calls: AskRequest[] } {
    const calls: AskRequest[] = [];
    return {
        fn: (r) => {
            calls.push(r);
            return Promise.resolve();
        },
        calls,
    };
}

/** Run one call the way the loop runs it: the approval hook, then the decision of the user on a request, then `execute`. */
async function runCall(
    tool: ReturnType<typeof createManageInputsTool>,
    input: { action: "add" | "remove" | "list"; paths?: string[] },
    analysisId: string,
    approve: (request: AskRequest) => Promise<void>,
): ReturnType<ReturnType<typeof createManageInputsTool>["execute"]> {
    const ctx = ctxFor(analysisId);
    const request = await tool.approval?.(input, { invocationId: ctx.invocationId, session: ctx.session });
    if (request !== undefined) await approve(request);
    return tool.execute(input, ctx);
}

/** Capture the input-mutation provenance events the profile-parity watcher (edge 2) consumes. */
function captureProv(): { types: string[]; stop: () => void } {
    const types: string[] = [];
    const handler = (e: BusEvent): void => {
        if (e.type === "prov.input_added" || e.type === "prov.input_removed") types.push(e.type);
    };
    Bus.on("inflexa", handler);
    return { types, stop: () => Bus.off("inflexa", handler) };
}

describe("manage_inputs tool", () => {
    const tool = createManageInputsTool();
    let dir = "";
    let analysisId = "";

    beforeEach(async () => {
        freshDb();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-mi-")));
        analysisId = (await createAnalysis({ cwd: dir, name: str256("mi")._unsafeUnwrap() }))._unsafeUnwrap().id;
    });

    afterEach(() => {
        releaseInstanceLock(analysisId);
        rmSync(dir, { recursive: true, force: true });
    });

    test("add registers an existing file, asks first, and emits prov.input_added", async () => {
        writeFileSync(join(dir, "data.csv"), "x,y\n1,2\n");
        acquireInstanceLock(analysisId);
        const ask = recordingAsk();
        const prov = captureProv();
        const result = (await runCall(tool, { action: "add", paths: ["data.csv"] }, analysisId, ask.fn))._unsafeUnwrap();
        prov.stop();

        expect(result.status).toBe("added");
        if (result.status === "added") expect(result.added).toEqual(["data.csv"]);
        expect(ask.calls).toHaveLength(1);
        expect(prov.types).toEqual(["prov.input_added"]);
    });

    test("add rejects a non-existent path before asking or mutating", async () => {
        acquireInstanceLock(analysisId);
        const ask = recordingAsk();
        const prov = captureProv();
        const result = (await runCall(tool, { action: "add", paths: ["ghost.csv"] }, analysisId, ask.fn))._unsafeUnwrap();
        prov.stop();

        expect(result.status).toBe("not_found");
        if (result.status === "not_found") expect(result.missing).toEqual(["ghost.csv"]);
        expect(ask.calls).toHaveLength(0);
        expect(prov.types).toHaveLength(0);
    });

    test("mutating without the analysis lock is refused — the single-writer guard", async () => {
        writeFileSync(join(dir, "data.csv"), "x\n");
        // Deliberately do NOT acquire the lock.
        const ask = recordingAsk();
        const result = (await runCall(tool, { action: "add", paths: ["data.csv"] }, analysisId, ask.fn))._unsafeUnwrap();

        expect(result.status).toBe("error");
        expect(ask.calls).toHaveLength(0);
    });

    test("remove drops a current input and emits prov.input_removed", async () => {
        writeFileSync(join(dir, "data.csv"), "x\n");
        acquireInstanceLock(analysisId);
        const ask = recordingAsk();
        await runCall(tool, { action: "add", paths: ["data.csv"] }, analysisId, ask.fn);

        const prov = captureProv();
        const result = (await runCall(tool, { action: "remove", paths: ["data.csv"] }, analysisId, ask.fn))._unsafeUnwrap();
        prov.stop();

        expect(result.status).toBe("removed");
        if (result.status === "removed") {
            expect(result.removed).toEqual(["data.csv"]);
            expect(result.notInputs).toEqual([]);
        }
        expect(prov.types).toEqual(["prov.input_removed"]);
    });

    test("remove tries each input after a failed removal, and names each failed and each removed input", async () => {
        const names = ["one.csv", "two.csv", "three.csv", "four.csv"];
        const anchorId = (await createAnalysis({ cwd: dir, name: str256("mi2")._unsafeUnwrap() }))._unsafeUnwrap().anchorId;
        for (const path of names) insertAnalysisInput({ path, isDir: false, analysisId, anchorId })._unsafeUnwrap();
        const failing = new Set(["two.csv", "three.csv"]);
        const failingTool = createManageInputsTool({
            removeInput: (input) => (failing.has(input.path) ? err({ type: "mutation_failed", op: "delete input", cause: "disk full" }) : removeInput(input)),
        });
        acquireInstanceLock(analysisId);

        const result = (await runCall(failingTool, { action: "remove", paths: names }, analysisId, recordingAsk().fn))._unsafeUnwrap();

        expect(result.status).toBe("error");
        if (result.status === "error") {
            expect(result.message).toContain("two.csv, three.csv");
            expect(result.message).toContain("one.csv, four.csv");
        }
        expect(
            listAnalysisInputs(analysisId)
                ._unsafeUnwrap()
                .map((i) => i.path)
                .toSorted(),
        ).toEqual(["three.csv", "two.csv"]);
    });

    test("remove reports a path that is not a current input as a no-op", async () => {
        acquireInstanceLock(analysisId);
        const ask = recordingAsk();
        const result = (await runCall(tool, { action: "remove", paths: ["never-added.csv"] }, analysisId, ask.fn))._unsafeUnwrap();

        expect(result.status).toBe("removed");
        if (result.status === "removed") {
            expect(result.removed).toEqual([]);
            expect(result.notInputs).toEqual(["never-added.csv"]);
        }
        expect(ask.calls).toHaveLength(0); // nothing matched, so nothing to confirm
    });

    test("list returns the current registered inputs without needing the lock", async () => {
        writeFileSync(join(dir, "data.csv"), "x\n");
        acquireInstanceLock(analysisId);
        const ask = recordingAsk();
        await runCall(tool, { action: "add", paths: ["data.csv"] }, analysisId, ask.fn);
        releaseInstanceLock(analysisId);

        const result = (await runCall(tool, { action: "list" }, analysisId, ask.fn))._unsafeUnwrap();
        expect(result.status).toBe("listed");
        if (result.status === "listed") expect(result.inputs.map((i) => i.path)).toContain("data.csv");
    });

    test("reports no_analysis (not no_anchor) when the scoped analysis row is gone", async () => {
        // A well-formed id with no DB row: findAnalysis returns ok(null) — nothing to act on, which is
        // no_analysis. no_anchor is reserved for an existing analysis whose anchor folder moved.
        const ask = recordingAsk();
        const result = (await runCall(tool, { action: "list" }, randomUUIDv7(), ask.fn))._unsafeUnwrap();
        expect(result.status).toBe("no_analysis");
    });
});

describe("manage_inputs — describeCall", () => {
    const tool = createManageInputsTool();

    /** Read the hook the way the harness emit site reads it. */
    function describeCall(input: { action: "add" | "remove" | "list"; paths?: string[] }): string | undefined {
        expect(tool.describeCall).toBeDefined();
        return tool.describeCall!(input);
    }

    test("a single-path add names the file", () => {
        expect(describeCall({ action: "add", paths: ["counts.csv"] })).toBe("add counts.csv");
    });

    test("a multi-path remove enumerates what fits on one line", () => {
        expect(describeCall({ action: "remove", paths: ["a.csv", "b.csv"] })).toBe("remove a.csv, b.csv");
        // A count is not the gate: five short names still fit.
        expect(describeCall({ action: "add", paths: ["a.csv", "b.csv", "c.csv", "d.csv", "e.csv"] })).toBe("add a.csv, b.csv, c.csv, d.csv, e.csv");
    });

    test("a list too long for the cap becomes a count, never a cut path", () => {
        // The harness would cut mid-path and mark it, which names a file that does
        // not exist. Two long absolute paths are enough to reach that.
        const long = [
            "/Users/alice/data/experiments/rnaseq/batch-02/counts_matrix_filtered.csv",
            "/Users/alice/data/experiments/rnaseq/batch-02/sample_metadata.tsv",
        ];
        expect(describeCall({ action: "add", paths: long })).toBe("add 2 paths");

        // The boundary: a rendered line of exactly the cap still enumerates.
        const atCap = "x".repeat(DETAIL_MAX_LENGTH - "add ".length);
        expect([...(describeCall({ action: "add", paths: [atCap] }) ?? "")].length).toBe(DETAIL_MAX_LENGTH);
        expect(describeCall({ action: "add", paths: [`${atCap}y`] })).toBe("add 1 path");
    });

    test("a list call is described by its action alone", () => {
        // `list` never carries paths, thus the detail must imply no target.
        expect(describeCall({ action: "list" })).toBe("list");
    });

    test("an add whose paths are absent still produces a detail", () => {
        // The schema permits the omission and `execute` rejects it. The hook
        // tolerates it rather than an assumption that the field is there.
        expect(describeCall({ action: "add" })).toBe("add");
        expect(describeCall({ action: "add", paths: [] })).toBe("add");
    });
});

describe("manage_inputs — view", () => {
    const tool = createManageInputsTool();
    let dir = "";
    let analysisId = "";

    beforeEach(async () => {
        freshDb();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-mi-")));
        analysisId = (await createAnalysis({ cwd: dir, name: str256("mi")._unsafeUnwrap() }))._unsafeUnwrap().id;
    });

    afterEach(() => {
        releaseInstanceLock(analysisId);
        rmSync(dir, { recursive: true, force: true });
    });

    test("an add call shows its input and its result, and the view declares the error", async () => {
        writeFileSync(join(dir, "data.csv"), "x,y\n1,2\n");
        acquireInstanceLock(analysisId);
        const input = { action: "add" as const, paths: ["data.csv"] };
        const result = (await runCall(tool, input, analysisId, recordingAsk().fn))._unsafeUnwrap();

        expect(result).toEqual({ status: "added", added: ["data.csv"] });
        expect(tool.view?.input?.(input)).toEqual(input);
        expect(tool.view?.result?.(input, result)).toEqual({ status: "added", added: ["data.csv"] });
        expect(tool.view?.error).toBe(true);
    });
});
