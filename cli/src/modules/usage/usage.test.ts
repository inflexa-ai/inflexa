import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { str256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import { getAnchor } from "../../db/primary_query.ts";
import { upsertLlmUsage, type LlmUsageEntry } from "../../db/primary_mutation.ts";
import { createAnalysis } from "../analysis/analysis.ts";
import { runUsage } from "./usage.ts";

// The action resolves its analysis from process.cwd(), so each test runs cd'd into the analysis's
// anchor folder. console.log is captured to keep the suite quiet and to assert on what was printed.
describe("usage command action", () => {
    let dir = "";
    let analysisId = "";
    let anchorId = "";
    let origCwd = "";
    let logs: string[] = [];
    const origLog = console.log;

    // Only the fields a given case cares about; everything else takes a plausible constant. Every
    // token quantity stays OPTIONAL here on purpose — a test that always supplies all five could not
    // tell a preserved absence from a zero.
    function record(key: string, over: Partial<LlmUsageEntry> & { usage: LlmUsageEntry["usage"] }): void {
        upsertLlmUsage({
            recordKey: key,
            recordedAt: 1,
            agentId: "conversation",
            callPath: "conversation",
            scopeKind: "analysis",
            scopeId: analysisId,
            ...over,
        })._unsafeUnwrap();
    }

    function output(): string {
        return logs.join("\n");
    }

    beforeEach(() => {
        freshDb();
        origCwd = process.cwd();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-usage-")));
        const analysis = createAnalysis({ cwd: dir, name: str256("usage")._unsafeUnwrap() })._unsafeUnwrap();
        analysisId = analysis.id;
        anchorId = analysis.anchorId;
        process.chdir(dir);
        logs = [];
        console.log = (...args: unknown[]): void => void logs.push(args.join(" "));
    });

    afterEach(() => {
        console.log = origLog;
        process.chdir(origCwd);
        rmSync(dir, { recursive: true, force: true });
    });

    test("reports the analysis's figures with a per-model and a per-agent breakdown", () => {
        record("k1", { agentId: "conversation", servedModelId: "opus-4", usage: { inputTokens: 10_000, outputTokens: 2_000 } });
        record("k2", { agentId: "conversation", servedModelId: "opus-4", usage: { inputTokens: 2_000, outputTokens: 1_000 } });
        record("k3", { agentId: "planner", servedModelId: "haiku-4", usage: { inputTokens: 400, outputTokens: 100 } });

        runUsage({});
        const out = output();

        expect(out).toContain('Usage for "usage" — 3 calls');
        // 12.4k in / 3.1k out — reported as TWO figures. The sum (15.5k) must appear nowhere.
        expect(out).toMatch(/input\s+12\.4k/);
        expect(out).toMatch(/output\s+3\.1k/);
        expect(out).not.toContain("15.5k");
        expect(out).toContain("By served model");
        expect(out).toMatch(/opus-4\s+2\s+12\.0k\s+3\.0k/);
        expect(out).toMatch(/haiku-4\s+1\s+400\s+100/);
        expect(out).toContain("By agent");
        expect(out).toMatch(/conversation\s+2\s+12\.0k\s+3\.0k/);
        expect(out).toMatch(/planner\s+1\s+400\s+100/);
    });

    test("resolves the analysis named by --analysis rather than the working context", () => {
        const other = createAnalysis({ cwd: dir, name: str256("other")._unsafeUnwrap() })._unsafeUnwrap();
        record("k1", { usage: { inputTokens: 999 } });
        upsertLlmUsage({
            recordKey: "k2",
            recordedAt: 1,
            agentId: "conversation",
            callPath: "conversation",
            scopeKind: "analysis",
            scopeId: other.id,
            usage: { inputTokens: 111 },
        })._unsafeUnwrap();

        runUsage({ analysis: "other" });
        const out = output();

        expect(out).toContain('Usage for "other"');
        // The sibling analysis's spend is attributed by scope id alone and cannot leak in.
        expect(out).toContain("111");
        expect(out).not.toContain("999");
    });

    test("an analysis with no recorded usage says so, with no zeroed figures and no table", () => {
        runUsage({});
        const out = output();

        expect(out).toContain('No usage recorded for "usage".');
        expect(out).not.toContain("input");
        expect(out).not.toContain("By served model");
        expect(out).not.toContain("0");
    });

    test("calls whose provider reported nothing are a report, distinct from no calls at all", () => {
        record("k1", { usage: {} });
        record("k2", { usage: {} });

        runUsage({});
        const out = output();

        // Two recorded calls that measured nothing: the count is the fact, the figures are unknowns.
        expect(out).toContain("2 calls");
        expect(out).not.toContain("No usage recorded");
        expect(out).toMatch(/input\s+not reported/);
        expect(out).toMatch(/output\s+not reported/);
    });

    test("an unreported quantity prints as unknown while a reported zero prints as zero", () => {
        record("k1", { usage: { inputTokens: 500, outputTokens: 0 } });

        runUsage({});
        const out = output();

        // outputTokens: 0 is a measurement the provider made; the absent cache/reasoning counts are not.
        expect(out).toMatch(/output\s+0/);
        expect(out).not.toContain("cache read");
        expect(out).not.toContain("reasoning");
    });

    test("cache and reasoning counts render as breakdowns and are never folded into the two figures", () => {
        record("k1", {
            usage: { inputTokens: 10_000, outputTokens: 2_000, cacheCreationInputTokens: 1_000, cacheReadInputTokens: 8_000, reasoningTokens: 900 },
        });

        runUsage({});
        const out = output();

        expect(out).toMatch(/input\s+10\.0k/);
        expect(out).toMatch(/cache write\s+1\.0k/);
        expect(out).toMatch(/cache read\s+8\.0k/);
        expect(out).toMatch(/output\s+2\.0k/);
        expect(out).toMatch(/reasoning\s+900/);
        // input + cacheRead (18.0k), input + output (12.0k), and all five (21.9k) are each a number
        // this report must never invent.
        for (const summed of ["18.0k", "12.0k", "21.9k"]) expect(out).not.toContain(summed);
    });

    test("reporting is not a sighting — the anchor's heartbeat is unchanged", () => {
        record("k1", { usage: { inputTokens: 100 } });
        const before = getAnchor(anchorId)._unsafeUnwrap();

        // Every anchor write stamps Date.now(), and the row was created moments ago in this same test
        // — plausibly the same millisecond — so a real clock read could write back the value the row
        // already holds and hide the heartbeat entirely. Pinning the clock to a value the row cannot
        // already carry is what makes a write detectable at all.
        const now = spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
        try {
            runUsage({}); // resolved from the working context …
            runUsage({ analysis: "usage" }); // … and named by flag: two resolve paths, both silent
        } finally {
            now.mockRestore();
        }

        // The whole row, not just lastSeen: the read must not have healed cachedPath or bumped
        // updatedAt either — the folder never moved, so the resolver had nothing to repair.
        expect(getAnchor(anchorId)._unsafeUnwrap()).toEqual(before);
    });

    test("calls whose endpoint reported no served model group under a labelled absence", () => {
        record("k1", { usage: { inputTokens: 100 } });

        runUsage({});

        expect(output()).toContain("(not reported)");
    });
});
