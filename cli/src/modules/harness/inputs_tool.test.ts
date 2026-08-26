import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DETAIL_MAX_LENGTH, type AgentSession, type AskApproval, type AskRequest, type ToolContext } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import { acquireInstanceLock, releaseInstanceLock } from "../../lib/lock.ts";
import { str256 } from "../../lib/types.ts";
import type { BusEvent } from "../../types/events.ts";
import { freshDb } from "../../test_support/db.ts";
import { createAnalysis } from "../analysis/analysis.ts";
import { createManageInputsTool } from "./inputs_tool.ts";

/** A minimal `ToolContext` carrying the analysis scope the tool reads, plus a stub `ask`. */
function ctxFor(analysisId: string, ask: (r: AskRequest) => Promise<AskApproval>): ToolContext {
    return {
        // The tool reads only `session.scope`; a cast avoids constructing the full value object.
        session: { scope: { kind: "analysis", analysisId } } as unknown as AgentSession,
        invocationId: "test-tool-call",
        signal: new AbortController().signal,
        emit: () => {},
        runStep: (_name, fn) => fn(),
        ask,
    };
}

/** An `ask` seam that records its requests and approves once. */
function recordingAsk(reply: AskApproval = { kind: "once" }): { fn: (r: AskRequest) => Promise<AskApproval>; calls: AskRequest[] } {
    const calls: AskRequest[] = [];
    return {
        fn: (r) => {
            calls.push(r);
            return Promise.resolve(reply);
        },
        calls,
    };
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
        const result = (await tool.execute({ action: "add", paths: ["data.csv"] }, ctxFor(analysisId, ask.fn)))._unsafeUnwrap();
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
        const result = (await tool.execute({ action: "add", paths: ["ghost.csv"] }, ctxFor(analysisId, ask.fn)))._unsafeUnwrap();
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
        const result = (await tool.execute({ action: "add", paths: ["data.csv"] }, ctxFor(analysisId, ask.fn)))._unsafeUnwrap();

        expect(result.status).toBe("error");
        expect(ask.calls).toHaveLength(0);
    });

    test("remove drops a current input and emits prov.input_removed", async () => {
        writeFileSync(join(dir, "data.csv"), "x\n");
        acquireInstanceLock(analysisId);
        const ask = recordingAsk();
        await tool.execute({ action: "add", paths: ["data.csv"] }, ctxFor(analysisId, ask.fn));

        const prov = captureProv();
        const result = (await tool.execute({ action: "remove", paths: ["data.csv"] }, ctxFor(analysisId, ask.fn)))._unsafeUnwrap();
        prov.stop();

        expect(result.status).toBe("removed");
        if (result.status === "removed") {
            expect(result.removed).toEqual(["data.csv"]);
            expect(result.notInputs).toEqual([]);
        }
        expect(prov.types).toEqual(["prov.input_removed"]);
    });

    test("remove reports a path that is not a current input as a no-op", async () => {
        acquireInstanceLock(analysisId);
        const ask = recordingAsk();
        const result = (await tool.execute({ action: "remove", paths: ["never-added.csv"] }, ctxFor(analysisId, ask.fn)))._unsafeUnwrap();

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
        await tool.execute({ action: "add", paths: ["data.csv"] }, ctxFor(analysisId, ask.fn));
        releaseInstanceLock(analysisId);

        const result = (await tool.execute({ action: "list" }, ctxFor(analysisId, ask.fn)))._unsafeUnwrap();
        expect(result.status).toBe("listed");
        if (result.status === "listed") expect(result.inputs.map((i) => i.path)).toContain("data.csv");
    });

    test("reports no_analysis (not no_anchor) when the scoped analysis row is gone", async () => {
        // A well-formed id with no DB row: findAnalysis returns ok(null) — nothing to act on, which is
        // no_analysis. no_anchor is reserved for an existing analysis whose anchor folder moved.
        const ask = recordingAsk();
        const result = (await tool.execute({ action: "list" }, ctxFor(randomUUIDv7(), ask.fn)))._unsafeUnwrap();
        expect(result.status).toBe("no_analysis");
    });
});

describe("manage_inputs — describeCall", () => {
    const tool = createManageInputsTool();

    /** Read the hook the way the harness emit site reads it. */
    function describeCall(input: { action: "add" | "remove" | "list"; paths?: string[] }): string {
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
        expect([...describeCall({ action: "add", paths: [atCap] })].length).toBe(DETAIL_MAX_LENGTH);
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
