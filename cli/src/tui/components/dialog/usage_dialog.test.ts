import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";

import { readSessionUsage, usageBreakdown, type SessionUsageSnapshot } from "./usage_dialog.tsx";
import type { UsageGrouping, UsageTotals, UsageView } from "../../../api/usage.ts";
import type { ClientOpts } from "../../../client/api.ts";

// The dialog's arithmetic, tested as pure functions. A character frame cannot carry these claims: it
// shows that two numbers painted, not WHICH two, and "this figure is never the sum of those" is
// exactly a statement about which. The painted ladder is covered by the render test beside this one.

function snapshot(over: Partial<SessionUsageSnapshot> = {}): SessionUsageSnapshot {
    return {
        totals: { calls: 0 },
        byModel: [],
        byAgent: [],
        ...over,
    };
}

/** Just the group rows — headings are asserted separately, by name. */
function rows(snap: SessionUsageSnapshot): string[] {
    return usageBreakdown(snap).lines.flatMap((l) => (l.kind === "row" ? [l.text] : []));
}

describe("usageBreakdown", () => {
    test("each row carries its call count beside one two-armed figure, never their sum", () => {
        const lines = rows(
            snapshot({
                totals: { calls: 2, inputTokens: 12_000, outputTokens: 3_000 },
                byModel: [{ servedModelId: "claude-opus-4-8", totals: { calls: 2, inputTokens: 12_000, outputTokens: 3_000 } }],
            }),
        );

        expect(lines.some((r) => /claude-opus-4-8\s+2\s+↑12\.0k ↓3\.0k/.test(r))).toBe(true);
        // 15.0k would be the two arms added; nothing here may produce it.
        expect(lines.join("\n")).not.toContain("15.0k");
    });

    test("the model and agent groupings each get their own heading, in that order", () => {
        const breakdown = usageBreakdown(
            snapshot({
                totals: { calls: 3, inputTokens: 100 },
                byModel: [{ servedModelId: "opus-4", totals: { calls: 3, inputTokens: 100 } }],
                byAgent: [{ agentId: "conversation", totals: { calls: 3, inputTokens: 100 } }],
            }),
        );

        expect(breakdown.lines.flatMap((l) => (l.kind === "heading" ? [l.text] : []))).toEqual(["By served model", "By agent"]);
        expect(breakdown.header).toContain("calls");
        expect(breakdown.header).toContain("tokens");
    });

    test("the grains the entities now report are gone — no session, run, step or unattributed section", () => {
        const breakdown = usageBreakdown(
            snapshot({
                totals: { calls: 3, inputTokens: 100 },
                byModel: [{ servedModelId: "opus-4", totals: { calls: 3, inputTokens: 100 } }],
                byAgent: [{ agentId: "conversation", totals: { calls: 3, inputTokens: 100 } }],
            }),
        );

        const headings = breakdown.lines.flatMap((l) => (l.kind === "heading" ? [l.text] : []));
        for (const gone of ["By session", "By run", "Unattributed"]) expect(headings).not.toContain(gone);
    });

    test("an empty snapshot composes nothing — the caller renders its own no-usage line", () => {
        expect(usageBreakdown(snapshot()).lines).toEqual([]);
    });

    test("rows within a section rank by input, then output, then calls — largest consumer first", () => {
        const ranked = usageBreakdown(
            snapshot({
                totals: { calls: 4, inputTokens: 1_000 },
                byAgent: [
                    { agentId: "small", totals: { calls: 2, inputTokens: 400, outputTokens: 900 } },
                    { agentId: "big", totals: { calls: 1, inputTokens: 500, outputTokens: 1 } },
                    { agentId: "silent", totals: { calls: 1 } },
                ],
            }),
        )
            .lines.flatMap((l) => (l.kind === "row" ? [l.text] : []))
            .map((t) => t.trim().split(/\s+/)[0]);

        // `small` reports more output and more calls; only the input-led order puts `big` first, and a
        // group that reported nothing sorts below one that reported zeros.
        expect(ranked).toEqual(["big", "small", "silent"]);
    });

    test("a group that reported no figures keeps its call count beside the absent word", () => {
        const lines = rows(
            snapshot({
                totals: { calls: 2 },
                byAgent: [{ agentId: "conversation", totals: { calls: 2 } }],
            }),
        );

        expect(lines.some((r) => /conversation\s+2\s+not reported/.test(r))).toBe(true);
        // Never a zero: "the provider measured nothing" is not "nothing was spent".
        expect(lines.some((r) => /conversation\s+2\s+↑0 ↓0/.test(r))).toBe(false);
    });

    test("a reported zero still prints as a measurement", () => {
        const lines = rows(
            snapshot({
                totals: { calls: 1, inputTokens: 0, outputTokens: 0 },
                byAgent: [{ agentId: "conversation", totals: { calls: 1, inputTokens: 0, outputTokens: 0 } }],
            }),
        );

        expect(lines.some((r) => r.includes("↑0 ↓0"))).toBe(true);
        expect(lines.some((r) => r.includes("not reported"))).toBe(false);
    });

    test("a half figure keeps the arm it has, rather than inventing the one it lacks", () => {
        const lines = rows(
            snapshot({
                totals: { calls: 1, inputTokens: 900 },
                byModel: [{ servedModelId: "opus-4", totals: { calls: 1, inputTokens: 900 } }],
            }),
        );

        expect(lines.some((r) => r.includes("↑900"))).toBe(true);
        expect(lines.some((r) => r.includes("↓"))).toBe(false);
    });

    test("calls whose endpoint reported no served model group under a labelled absence", () => {
        const lines = rows(
            snapshot({
                totals: { calls: 1, inputTokens: 10 },
                byModel: [{ servedModelId: null, totals: { calls: 1, inputTokens: 10 } }],
            }),
        );

        expect(lines.some((r) => r.trim().startsWith("(not reported)"))).toBe(true);
    });

    test("the columns are measured across BOTH sections, so figures line up down the whole panel", () => {
        const breakdown = usageBreakdown(
            snapshot({
                totals: { calls: 5, inputTokens: 100 },
                byModel: [{ servedModelId: "a-very-long-served-model-identifier", totals: { calls: 4, inputTokens: 90 } }],
                byAgent: [{ agentId: "conversation", totals: { calls: 1, inputTokens: 10 } }],
            }),
        );

        const at = breakdown.lines.flatMap((l) => (l.kind === "row" ? [l.text.indexOf("↑")] : []));
        expect(at).toHaveLength(2);
        expect(at[0]).toBe(at[1]!);
    });
});

/**
 * A client whose server answers `GET {A}/usage` with `views[by]` for the grouping of each request, and
 * records each requested URL. A request that has no view fails the test through a 500.
 */
function serverWith(views: Partial<Record<UsageGrouping, UsageView>>, seen: string[]): ClientOpts {
    return {
        discover: () => ok({ baseUrl: "http://server.test", token: "t" }),
        fetch: async (url) => {
            seen.push(url);
            const view = views[new URL(url).searchParams.get("by") as UsageGrouping];
            return view === undefined
                ? new Response(JSON.stringify({ error: "internal_error", message: "no view" }), { status: 500 })
                : new Response(JSON.stringify(view), { headers: { "Content-Type": "application/json" } });
        },
    };
}

describe("readSessionUsage", () => {
    test("an unbound thread answers the empty snapshot without a request", async () => {
        const seen: string[] = [];
        const snap = (await readSessionUsage("an-1", null, serverWith({}, seen)))._unsafeUnwrap();

        expect(snap).toEqual({ totals: { calls: 0 }, byModel: [], byAgent: [] });
        expect(seen).toEqual([]);
    });

    test("the empty snapshot renders as no-usage rather than as a zeroed table", async () => {
        const snap: SessionUsageSnapshot = (await readSessionUsage("an-1", null))._unsafeUnwrap();
        const totals: UsageTotals = snap.totals;

        expect(totals.calls).toBe(0);
        expect(usageBreakdown(snap).lines).toEqual([]);
    });

    test("reads the conversation, runs included, once for each grouping, and keeps an absent quantity absent", async () => {
        const totals: UsageTotals = { calls: 2, inputTokens: 820_300 };
        const scope = { kind: "thread", threadId: "thr-1" } as const;
        const seen: string[] = [];
        const opts = serverWith(
            {
                model: { scope, totals, groups: [{ key: null, totals: { calls: 2, inputTokens: 820_300 } }] },
                agent: { scope, totals, groups: [{ key: "step-executor", totals: { calls: 2, inputTokens: 820_300 } }] },
            },
            seen,
        );

        const snap = (await readSessionUsage("an-1", "thr-1", opts))._unsafeUnwrap();

        expect(seen).toEqual([
            "http://server.test/api/v1/analyses/an-1/usage?threadId=thr-1&by=model",
            "http://server.test/api/v1/analyses/an-1/usage?threadId=thr-1&by=agent",
        ]);
        expect(snap).toEqual({
            totals,
            byModel: [{ servedModelId: null, totals: { calls: 2, inputTokens: 820_300 } }],
            byAgent: [{ agentId: "step-executor", totals: { calls: 2, inputTokens: 820_300 } }],
        });
        expect(snap.totals.outputTokens).toBeUndefined();
    });

    test("a failed grouping read fails the whole snapshot", async () => {
        const totals: UsageTotals = { calls: 1, inputTokens: 10 };
        const opts = serverWith({ model: { scope: { kind: "thread", threadId: "thr-1" }, totals, groups: [] } }, []);

        expect((await readSessionUsage("an-1", "thr-1", opts)).isErr()).toBe(true);
    });
});
