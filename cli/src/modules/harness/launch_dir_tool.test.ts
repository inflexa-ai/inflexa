import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, ToolContext } from "@inflexa-ai/harness";

import { str256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { addInputs, createAnalysis } from "../analysis/analysis.ts";
import { createLaunchDirTool } from "./launch_dir_tool.ts";

function ctxFor(analysisId: string): ToolContext {
    return {
        session: { scope: { kind: "analysis", analysisId } } as unknown as AgentSession,
        signal: new AbortController().signal,
        emit: () => {},
        runStep: (_name, fn) => fn(),
        // The launch-dir tool never asks — surface an ask that fails loudly if it ever does.
        ask: () => Promise.reject(new Error("list_launch_dir must not ask")),
    };
}

describe("list_launch_dir tool", () => {
    const tool = createLaunchDirTool();
    let dir = "";
    let analysisId = "";

    beforeEach(() => {
        freshDb();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-ld-")));
        analysisId = createAnalysis({ cwd: dir, name: str256("ld")._unsafeUnwrap() })._unsafeUnwrap().id;
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("lists anchor-folder files with sizes, excludes noise dirs, and marks registered inputs", async () => {
        writeFileSync(join(dir, "a.csv"), "12345"); // 5 bytes
        mkdirSync(join(dir, "sub"));
        writeFileSync(join(dir, "sub", "b.txt"), "hi");
        // Noise directories the staging walk skips — must never be enumerated.
        mkdirSync(join(dir, ".git"));
        writeFileSync(join(dir, ".git", "config"), "x");
        mkdirSync(join(dir, "node_modules"));
        writeFileSync(join(dir, "node_modules", "pkg.js"), "x");

        // Register a.csv so the tool marks it as already an input.
        addInputs(analysisId, ["a.csv"], dir)._unsafeUnwrap();

        const result = (await tool.execute({}, ctxFor(analysisId)))._unsafeUnwrap();
        expect(result.status).toBe("listed");
        if (result.status !== "listed") return;

        const byPath = new Map(result.entries.map((e) => [e.path, e]));
        expect([...byPath.keys()].sort()).toEqual(["a.csv", join("sub", "b.txt")]);
        expect(byPath.get("a.csv")).toEqual({ path: "a.csv", size: 5, registered: true });
        expect(byPath.get(join("sub", "b.txt"))?.registered).toBe(false);
        // No noise-dir file appears.
        expect(result.entries.some((e) => e.path.includes(".git") || e.path.includes("node_modules"))).toBe(false);
    });

    test("is read-only — listing writes no inputs", async () => {
        writeFileSync(join(dir, "a.csv"), "x");
        await tool.execute({}, ctxFor(analysisId));
        await tool.execute({}, ctxFor(analysisId));
        expect(listAnalysisInputs(analysisId)._unsafeUnwrap()).toHaveLength(0);
    });

    test("reports no_analysis outside an analysis scope", async () => {
        const ctx: ToolContext = {
            session: { scope: { kind: "target-assessment", targetAssessmentId: "ta1", billingContextId: "b1" } } as unknown as AgentSession,
            signal: new AbortController().signal,
            emit: () => {},
            runStep: (_name, fn) => fn(),
            ask: () => Promise.reject(new Error("no ask")),
        };
        const result = (await tool.execute({}, ctx))._unsafeUnwrap();
        expect(result.status).toBe("no_analysis");
    });

    test("reports no_analysis (not no_anchor) when the scoped analysis row is gone", async () => {
        // A well-formed id the DB has no row for: findAnalysis returns ok(null) — nothing to act on,
        // which is no_analysis. no_anchor is reserved for an existing analysis whose folder moved.
        const result = (await tool.execute({}, ctxFor(randomUUIDv7())))._unsafeUnwrap();
        expect(result.status).toBe("no_analysis");
    });
});
