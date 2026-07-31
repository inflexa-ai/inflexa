import { describe, expect, test } from "bun:test";

import { distinctIdTails, usageBreakdown, usageHeadlineRows, usageStepLines, type UsageSnapshot } from "./usage_dialog.tsx";
import type { LlmUsageTotals } from "../../../db/primary_query.ts";
import { idTail } from "../../hooks/sidebar_live.ts";

// The dialog's arithmetic, tested as pure functions. A character frame cannot carry these claims: it
// shows that two numbers painted, not WHICH two, and "this figure is never the sum of those" is
// exactly a statement about which. The painted ladder is covered by the render test beside this one.

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
    return {
        totals: { calls: 0 },
        sessions: [],
        runs: [],
        unattributed: { calls: 0 },
        byModel: [],
        byAgent: [],
        ...over,
    };
}

function titles(snap: UsageSnapshot, names?: ReadonlyMap<string, string>): string[] {
    return usageBreakdown(snap, names).items.map((i) => i.title);
}

describe("distinctIdTails", () => {
    test("non-colliding ids keep the six-character tail every other surface prints", () => {
        const a = "11111111-2222-3333-4444-5555aabbccdd";
        const b = "99999999-8888-7777-6666-5555ffeeddcc";
        const labels = distinctIdTails([a, b]);

        expect(labels.get(a)).toBe(idTail(a));
        expect(labels.get(b)).toBe(idTail(b));
        expect(labels.get(a)).toBe("bbccdd");
    });

    test("two ids sharing a tail both extend to the shortest length that tells them apart", () => {
        const a = "11111111-2222-3333-4444-5555a1bbccdd";
        const b = "11111111-2222-3333-4444-5555b2bbccdd";
        const labels = distinctIdTails([a, b]);

        // Seven characters is the first length at which the two diverge; neither row keeps the
        // ambiguous six, and neither grows further than it has to.
        expect(labels.get(a)).toBe("1bbccdd");
        expect(labels.get(b)).toBe("2bbccdd");
    });

    test("a collision extends only the rows involved, leaving every other row at its tail", () => {
        const a = "11111111-2222-3333-4444-5555a1bbccdd";
        const b = "11111111-2222-3333-4444-5555b2bbccdd";
        const other = "99999999-8888-7777-6666-5555ffeeddcc";
        const labels = distinctIdTails([a, b, other]);

        expect(labels.get(other)).toBe(idTail(other));
        expect(labels.get(other)?.length).toBe(6);
    });

    test("the same id listed twice is one label, not a self-collision", () => {
        const a = "11111111-2222-3333-4444-5555aabbccdd";
        expect(distinctIdTails([a, a]).get(a)).toBe(idTail(a));
    });
});

describe("usageHeadlineRows", () => {
    test("renders two figures with each breakdown nested under the one it details", () => {
        const totals: LlmUsageTotals = {
            calls: 3,
            inputTokens: 10_000,
            outputTokens: 2_000,
            cacheCreationInputTokens: 1_000,
            cacheReadInputTokens: 8_000,
            reasoningTokens: 900,
        };

        expect(usageHeadlineRows(totals)).toEqual([
            ["input", "10.0k"],
            ["  cache write", "1.0k"],
            ["  cache read", "8.0k"],
            ["output", "2.0k"],
            ["  reasoning", "900"],
        ]);
    });

    test("never constructs a combined figure from the five quantities", () => {
        const values = usageHeadlineRows({
            calls: 1,
            inputTokens: 10_000,
            outputTokens: 2_000,
            cacheCreationInputTokens: 1_000,
            cacheReadInputTokens: 8_000,
            reasoningTokens: 900,
        }).map(([, v]) => v);

        // input+cacheRead (18.0k), input+output (12.0k), and all five (21.9k) are each a number no
        // surface may invent — a cached prefix is already inside inputTokens.
        for (const summed of ["18.0k", "12.0k", "21.9k"]) expect(values).not.toContain(summed);
    });

    test("an absent quantity omits its breakdown line and prints the headline figure as a word", () => {
        const rows = usageHeadlineRows({ calls: 2, outputTokens: 0 });

        expect(rows).toEqual([
            ["input", "not reported"],
            // A reported zero is a measurement and prints; the absent cache/reasoning lines do not exist.
            ["output", "0"],
        ]);
    });
});

describe("usageBreakdown", () => {
    test("each row carries its call count beside exactly two figures", () => {
        const rows = titles(
            snapshot({
                totals: { calls: 2, inputTokens: 12_000, outputTokens: 3_000 },
                sessions: [{ threadId: "aaaaaaaa-bbbb-cccc-dddd-eeee11112222", totals: { calls: 2, inputTokens: 12_000, outputTokens: 3_000 } }],
            }),
        );

        expect(rows.some((r) => /112222\s+2\s+12\.0k\s+3\.0k/.test(r))).toBe(true);
        // 15.0k would be the two figures added; nothing here may produce it.
        expect(rows.join("\n")).not.toContain("15.0k");
    });

    test("sessions, runs, model and agent each get their own section", () => {
        const breakdown = usageBreakdown(
            snapshot({
                totals: { calls: 3, inputTokens: 100 },
                sessions: [{ threadId: "aaaaaaaa-bbbb-cccc-dddd-eeee11112222", totals: { calls: 1, inputTokens: 10 } }],
                runs: [{ runId: "99999999-8888-7777-6666-5555ffeeddcc", totals: { calls: 1, inputTokens: 60 } }],
                byModel: [{ servedModelId: "opus-4", totals: { calls: 3, inputTokens: 100 } }],
                byAgent: [{ agentId: "conversation", totals: { calls: 3, inputTokens: 100 } }],
            }),
        );

        expect([...new Set(breakdown.items.map((i) => i.category))]).toEqual(["By session", "By run", "By served model", "By agent"]);
        expect(breakdown.header).toContain("calls");
        expect(breakdown.header).toContain("input");
        expect(breakdown.header).toContain("output");
    });

    test("a grain with no groups says so rather than vanishing", () => {
        const breakdown = usageBreakdown(
            snapshot({
                totals: { calls: 1, inputTokens: 10 },
                sessions: [{ threadId: "aaaaaaaa-bbbb-cccc-dddd-eeee11112222", totals: { calls: 1, inputTokens: 10 } }],
            }),
        );

        expect(breakdown.items.map((i) => i.title)).toContain("no runs recorded");
        // The placeholder is not actionable — only a real run row drills.
        expect(breakdown.items.every((i) => i.value.kind === "inert" || i.value.kind === "run")).toBe(true);
        expect(breakdown.items.filter((i) => i.value.kind === "run")).toHaveLength(0);
    });

    test("only run rows are drillable, and each carries its own run id", () => {
        const breakdown = usageBreakdown(
            snapshot({
                totals: { calls: 2, inputTokens: 10 },
                sessions: [{ threadId: "aaaaaaaa-bbbb-cccc-dddd-eeee11112222", totals: { calls: 1, inputTokens: 5 } }],
                runs: [{ runId: "99999999-8888-7777-6666-5555ffeeddcc", totals: { calls: 1, inputTokens: 5 } }],
            }),
        );

        const drillable = breakdown.items.filter((i) => i.value.kind === "run");
        expect(drillable).toHaveLength(1);
        expect(drillable[0]?.value).toEqual({ kind: "run", runId: "99999999-8888-7777-6666-5555ffeeddcc" });
    });

    test("work belonging to no session or run is shown as its own group", () => {
        const rows = titles(
            snapshot({
                totals: { calls: 1, inputTokens: 400 },
                unattributed: { calls: 1, inputTokens: 400, outputTokens: 40 },
            }),
        );

        expect(rows.some((r) => r.startsWith("(no session or run)"))).toBe(true);
    });

    test("an unattributed bucket holding nothing is not announced", () => {
        const breakdown = usageBreakdown(
            snapshot({
                totals: { calls: 1, inputTokens: 10 },
                sessions: [{ threadId: "aaaaaaaa-bbbb-cccc-dddd-eeee11112222", totals: { calls: 1, inputTokens: 10 } }],
            }),
        );

        expect(breakdown.items.map((i) => i.category)).not.toContain("Unattributed");
    });

    test("a known name rides BESIDE the id, and its absence changes nothing else about the row", () => {
        const runId = "99999999-8888-7777-6666-5555ffeeddcc";
        const snap = snapshot({
            totals: { calls: 1, inputTokens: 60 },
            runs: [{ runId, totals: { calls: 1, inputTokens: 60, outputTokens: 6 } }],
        });

        const cold = titles(snap).find((t) => t.startsWith(idTail(runId)));
        const warm = titles(snap, new Map([[runId, "Differential expression"]])).find((t) => t.startsWith(idTail(runId)));

        // The id tail leads both times — the row reads the same cold or warm; the name is additional text.
        expect(cold).toBeDefined();
        expect(warm).toBeDefined();
        expect(warm).toContain("Differential expression");
        expect(cold).not.toContain("Differential expression");
    });

    test("rows within a grain rank by input, then output, then calls — largest consumer first", () => {
        const rows = usageBreakdown(
            snapshot({
                totals: { calls: 4, inputTokens: 1_000 },
                byAgent: [
                    { agentId: "small", totals: { calls: 2, inputTokens: 400, outputTokens: 900 } },
                    { agentId: "big", totals: { calls: 1, inputTokens: 500, outputTokens: 1 } },
                    { agentId: "silent", totals: { calls: 1 } },
                ],
            }),
        )
            .items.filter((i) => i.category === "By agent")
            .map((i) => i.title.trim().split(/\s+/)[0]);

        // `small` reports more output and more calls; only the input-led order puts `big` first, and a
        // group that reported nothing sorts below one that reported zeros.
        expect(rows).toEqual(["big", "small", "silent"]);
    });

    test("a group that reported no figures keeps its call count beside the absent word", () => {
        const rows = titles(
            snapshot({
                totals: { calls: 2 },
                runs: [{ runId: "99999999-8888-7777-6666-5555ffeeddcc", totals: { calls: 2 } }],
            }),
        );

        expect(rows.some((r) => /eeddcc\s+2\s+not reported\s+not reported/.test(r))).toBe(true);
        // Never a zero: "the provider measured nothing" is not "nothing was spent".
        expect(rows.some((r) => /eeddcc\s+2\s+0\s+0/.test(r))).toBe(false);
    });

    test("calls whose endpoint reported no served model group under a labelled absence", () => {
        const rows = titles(
            snapshot({
                totals: { calls: 1, inputTokens: 10 },
                byModel: [{ servedModelId: null, totals: { calls: 1, inputTokens: 10 } }],
            }),
        );

        expect(rows.some((r) => r.startsWith("(not reported)"))).toBe(true);
    });
});

describe("usageStepLines", () => {
    test("renders one row per step with its call count and two figures", () => {
        const lines = usageStepLines([
            { stepId: "s1_load", totals: { calls: 2, inputTokens: 12_000, outputTokens: 3_000 } },
            { stepId: "s2_align", totals: { calls: 1, inputTokens: 400, outputTokens: 100 } },
        ]);

        expect(lines[0]).toMatch(/step\s+calls\s+input\s+output/);
        expect(lines[1]).toMatch(/s1_load\s+2\s+12\.0k\s+3\.0k/);
        expect(lines[2]).toMatch(/s2_align\s+1\s+400\s+100/);
        // 15.0k is the two figures added — a number this view must never produce.
        expect(lines.join("\n")).not.toContain("15.0k");
    });

    test("a run's calls outside any step are labelled as such, not blank", () => {
        const lines = usageStepLines([{ stepId: null, totals: { calls: 1, inputTokens: 30 } }]);
        expect(lines[1]).toMatch(/\(no step\)\s+1\s+30\s+not reported/);
    });

    test("a run with no recorded steps renders the header alone, never a zeroed row", () => {
        expect(usageStepLines([])).toEqual(["step  calls  input  output"]);
    });
});
