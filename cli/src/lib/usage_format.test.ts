import { describe, expect, test } from "bun:test";

import { GLYPHS, size, space } from "./design_system.ts";
import { formatTokenFigure, formatTokenFigureLabelled, tokenFigureDetail, type TokenQuantities } from "./usage_format.ts";

// The design's real ledger figures, chosen so the rendered string is the exact one the spec writes.
const IN = 767_600;
const OUT = 33_100;

/**
 * A rail content row's usable width in cells: the rail less its left border and its symmetric
 * horizontal padding. Re-derived from the same tokens the sidebar box applies rather than imported,
 * because the sidebar keeps its copy module-private — but derived, never a literal, so a retuned
 * `size.railWidth` moves this budget with it instead of leaving the test asserting a width the
 * product no longer renders.
 */
const RAIL_CONTENT_WIDTH = size.railWidth - 1 - space.sm * 2;

describe("formatTokenFigure", () => {
    test("renders both arms as the one notation", () => {
        expect(formatTokenFigure({ inputTokens: IN, outputTokens: OUT })).toBe("↑767.6k ↓33.1k");
    });

    test("takes its arrows from the shared glyph registry, never an inlined literal", () => {
        const figure = formatTokenFigure({ inputTokens: IN, outputTokens: OUT });
        expect(figure.startsWith(GLYPHS.arrowUp)).toBe(true);
        expect(figure).toContain(GLYPHS.arrowDown);
    });

    test("renders the input arm alone, with no zero output arm", () => {
        const figure = formatTokenFigure({ inputTokens: IN });
        expect(figure).toBe("↑767.6k");
        expect(figure).not.toContain(GLYPHS.arrowDown);
    });

    test("renders the output arm alone, with no zero input arm", () => {
        const figure = formatTokenFigure({ outputTokens: OUT });
        expect(figure).toBe("↓33.1k");
        expect(figure).not.toContain(GLYPHS.arrowUp);
    });

    test("renders nothing reported as the empty string, not a zero figure", () => {
        // The distinguishable-empty contract: a caller tests this exact value to pick a muted absence.
        // A `0` here would assert "nothing was spent", which is not a fact the ledger holds.
        expect(formatTokenFigure({})).toBe("");
        expect(formatTokenFigure({ cacheReadInputTokens: 4_096 })).toBe("");
    });

    test("prints a provider-reported zero", () => {
        expect(formatTokenFigure({ inputTokens: IN, outputTokens: 0 })).toBe("↑767.6k ↓0");
        expect(formatTokenFigure({ inputTokens: 0, outputTokens: 0 })).toBe("↑0 ↓0");
    });

    test("never prints a combined total", () => {
        // The two counts are not summable — cache reads are already inside input — so the figure must
        // show two numbers and never the one a reader could mistake for a total.
        expect(formatTokenFigure({ inputTokens: 1_000, outputTokens: 1_000 })).toBe("↑1.0k ↓1.0k");
        expect(formatTokenFigure({ inputTokens: 1_000, outputTokens: 1_000 })).not.toContain("2.0k");
    });

    test("fits the rail's design width on one line", () => {
        // Every character is ASCII or a GLYPHS arrow, single-cell by the registry's contract, so
        // `.length` measures terminal cells exactly here. The second case is a billions-scale pair at
        // `formatTokens`'s top unit — far past any real ledger, and checked alongside the typical one
        // so the fit reads as headroom rather than as an observation about today's numbers.
        const typical = formatTokenFigure({ inputTokens: IN, outputTokens: OUT });
        const topUnit = formatTokenFigure({ inputTokens: 1_000_000_000, outputTokens: 1_000_000_000 });
        // Pinned so a re-introduced label or separator (`767.6k in · 33.1k out` was 26 cells) fails
        // here rather than by quietly wrapping a rail that already wraps.
        expect(typical).toHaveLength(14);
        expect(topUnit).toBe("↑1000.0M ↓1000.0M");
        for (const figure of [typical, topUnit]) {
            expect(figure).not.toContain("\n");
            expect(figure.length).toBeLessThanOrEqual(RAIL_CONTENT_WIDTH);
        }
    });
});

// The labelled form is the SAME figure written for a surface whose subject IS the number. Every
// claim below is deliberately the twin of one in the compact block above: the two forms are only
// allowed to differ in how a quantity is labelled, so any rule asserted of one has to hold of the
// other or a reader comparing the rail against a row is comparing two different measurements.
describe("formatTokenFigureLabelled", () => {
    test("names each quantity in words, joined by the shared separator glyph", () => {
        expect(formatTokenFigureLabelled({ inputTokens: IN, outputTokens: OUT })).toBe("767.6k in · 33.1k out");
    });

    test("carries the same values as the compact form, differing only in the labelling", () => {
        // The one claim that makes two forms safe to have at all. Stripping the arrows and the words
        // from each rendering must leave the identical pair of numbers, in the identical order.
        for (const q of [
            { inputTokens: IN, outputTokens: OUT },
            { inputTokens: 0, outputTokens: 0 },
            { inputTokens: IN },
            { outputTokens: OUT },
            { inputTokens: 1_000_000_000, outputTokens: 1_000_000_000 },
        ] satisfies TokenQuantities[]) {
            const compactValues = formatTokenFigure(q)
                .split(" ")
                .map((arm) => arm.slice(GLYPHS.arrowUp.length));
            const labelledValues = formatTokenFigureLabelled(q)
                .split(` ${GLYPHS.middot} `)
                .map((arm) => arm.split(" ")[0]);
            expect(labelledValues).toEqual(compactValues);
        }
    });

    test("omits an absent arm rather than labelling a zero", () => {
        expect(formatTokenFigureLabelled({ inputTokens: IN })).toBe("767.6k in");
        expect(formatTokenFigureLabelled({ outputTokens: OUT })).toBe("33.1k out");
    });

    test("renders nothing reported as the empty string, exactly as the compact form does", () => {
        // Absence is a property of the DATA. A form that substituted a word here while the other
        // returned "" would make the two disagree about whether anything was measured.
        expect(formatTokenFigureLabelled({})).toBe("");
        expect(formatTokenFigureLabelled({ cacheReadInputTokens: 4_096 })).toBe("");
    });

    test("prints a provider-reported zero", () => {
        expect(formatTokenFigureLabelled({ inputTokens: IN, outputTokens: 0 })).toBe("767.6k in · 0 out");
        expect(formatTokenFigureLabelled({ inputTokens: 0, outputTokens: 0 })).toBe("0 in · 0 out");
    });

    test("never prints a combined total", () => {
        expect(formatTokenFigureLabelled({ inputTokens: 1_000, outputTokens: 1_000 })).not.toContain("2.0k");
    });

    test("fits the rail's design width on one line, which is why the rail can print it whole", () => {
        // The USAGE section falls back to this joined line when nothing nests under either arm, so it
        // has to fit the same budget the compact form was measured against — 26 cells at the top unit,
        // against a 37-cell rail, is the headroom that makes the fallback safe rather than lucky.
        const typical = formatTokenFigureLabelled({ inputTokens: IN, outputTokens: OUT });
        const topUnit = formatTokenFigureLabelled({ inputTokens: 1_000_000_000, outputTokens: 1_000_000_000 });
        expect(topUnit).toBe("1000.0M in · 1000.0M out");
        for (const figure of [typical, topUnit]) {
            expect(figure).not.toContain("\n");
            expect(figure.length).toBeLessThanOrEqual(RAIL_CONTENT_WIDTH);
        }
    });
});

describe("tokenFigureDetail", () => {
    test("nests the cache quantities under input, never beside it", () => {
        const detail = tokenFigureDetail({
            inputTokens: IN,
            outputTokens: OUT,
            cacheCreationInputTokens: 12_400,
            cacheReadInputTokens: 700_000,
        });
        expect(detail.input?.compact).toBe("↑767.6k");
        expect(detail.input?.labelled).toBe("767.6k in");
        expect(detail.input?.breakdown).toEqual([
            { label: "cache write", value: "12.4k" },
            { label: "cache read", value: "700.0k" },
        ]);
        // The relationship is carried by the structure: the cache slices are unreachable except
        // through the input arm, so they can never be siblings of input and output.
        expect(detail.output?.breakdown).toEqual([]);
    });

    test("nests reasoning under output", () => {
        const detail = tokenFigureDetail({ inputTokens: IN, outputTokens: OUT, reasoningTokens: 8_000 });
        expect(detail.output?.compact).toBe("↓33.1k");
        expect(detail.output?.labelled).toBe("33.1k out");
        expect(detail.output?.breakdown).toEqual([{ label: "reasoning", value: "8.0k" }]);
    });

    test("carries no arrow on a breakdown — only an arm names a direction", () => {
        const detail = tokenFigureDetail({ inputTokens: IN, cacheReadInputTokens: 700_000 });
        for (const part of detail.input?.breakdown ?? []) {
            expect(part.value).not.toContain(GLYPHS.arrowUp);
            expect(part.value).not.toContain(GLYPHS.arrowDown);
        }
    });

    test("omits an absent breakdown and prints a reported zero one", () => {
        const detail = tokenFigureDetail({ inputTokens: IN, cacheCreationInputTokens: 0 });
        expect(detail.input?.breakdown).toEqual([{ label: "cache write", value: "0" }]);
    });

    test("drops a breakdown whose arm was never reported", () => {
        // A slice with no parent could only render as a sibling of input and output, which is the one
        // layout the notation forbids. `inflexa usage` remains the surface that shows it.
        const detail = tokenFigureDetail({ outputTokens: OUT, cacheReadInputTokens: 700_000 });
        expect(detail.input).toBeNull();
        expect(detail.output?.compact).toBe("↓33.1k");
    });

    test("reports nothing reported as both arms null, agreeing with BOTH one-line forms", () => {
        const quantities = { cacheReadInputTokens: 700_000, reasoningTokens: 8_000 };
        const detail = tokenFigureDetail(quantities);
        expect(detail).toEqual({ input: null, output: null });
        expect(formatTokenFigure(quantities)).toBe("");
        expect(formatTokenFigureLabelled(quantities)).toBe("");
        expect(tokenFigureDetail({})).toEqual({ input: null, output: null });
    });

    test("prints a provider-reported zero arm rather than dropping it, in both writings", () => {
        const detail = tokenFigureDetail({ inputTokens: 0, outputTokens: 0 });
        expect(detail.input?.compact).toBe("↑0");
        expect(detail.output?.compact).toBe("↓0");
        expect(detail.input?.labelled).toBe("0 in");
        expect(detail.output?.labelled).toBe("0 out");
    });

    test("writes each arm exactly as the one-line form of the same name writes it", () => {
        // The two renderings of one set of quantities must be the same figure, not two dialects — and
        // a nesting surface printing arms itself must produce the same characters as the joined line.
        const quantities = { inputTokens: IN, outputTokens: OUT, cacheReadInputTokens: 700_000 };
        const detail = tokenFigureDetail(quantities);
        expect(`${detail.input?.compact} ${detail.output?.compact}`).toBe(formatTokenFigure(quantities));
        expect(`${detail.input?.labelled} ${GLYPHS.middot} ${detail.output?.labelled}`).toBe(formatTokenFigureLabelled(quantities));
    });
});
