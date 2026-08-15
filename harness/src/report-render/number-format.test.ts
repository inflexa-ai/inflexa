import { describe, expect, it } from "bun:test";

import { formatNumberCell, selectNumberKind } from "./number-format.js";

describe("formatNumberCell scientific", () => {
    it("gives a coefficient of two significant digits and an exponent", () => {
        expect(formatNumberCell(0.0000427777663038, "scientific")).toEqual({ text: "4.3e-5", full: "0.0000427777663038" });
    });

    it("trims the trailing zero of the coefficient", () => {
        expect(formatNumberCell(0.5, "scientific")).toEqual({ text: "5e-1" });
    });

    it("keeps a value that the two digits already carry, and gives no full form", () => {
        expect(formatNumberCell(2.7e-10, "scientific")).toEqual({ text: "2.7e-10" });
    });
});

describe("formatNumberCell compact", () => {
    it("groups the digits of a large integer", () => {
        expect(formatNumberCell(14201, "compact")).toEqual({ text: "14,201" });
    });

    it("groups each run of three digits", () => {
        expect(formatNumberCell(1234567, "compact")).toEqual({ text: "1,234,567" });
    });

    it("keeps the sign in front of the groups", () => {
        expect(formatNumberCell(-1234567, "compact")).toEqual({ text: "-1,234,567" });
    });

    it("gives no full form for a short integer", () => {
        expect(formatNumberCell(42, "compact")).toEqual({ text: "42" });
    });
});

describe("formatNumberCell compact-scientific", () => {
    it("rounds a long float to three significant digits", () => {
        expect(formatNumberCell(-3.089028528355109, "compact-scientific")).toEqual({ text: "-3.09", full: "-3.089028528355109" });
    });

    it("falls to the scientific form under one thousandth", () => {
        expect(formatNumberCell(-0.00012345, "compact-scientific")).toEqual({ text: "-1.2e-4", full: "-0.00012345" });
    });

    it("keeps a value that three digits already carry, and gives no full form", () => {
        expect(formatNumberCell(2.94, "compact-scientific")).toEqual({ text: "2.94" });
    });

    it("shows zero as one digit", () => {
        expect(formatNumberCell(0, "compact-scientific")).toEqual({ text: "0" });
    });
});

describe("formatNumberCell pass-through", () => {
    it("passes a non-numeric string through unchanged and gives no full form", () => {
        expect(formatNumberCell("up", "compact-scientific")).toEqual({ text: "up" });
    });

    it("passes a value with a unit suffix through unchanged", () => {
        expect(formatNumberCell("42.6M", "compact")).toEqual({ text: "42.6M" });
    });

    it("formats a numeric string and keeps the source text as the full form", () => {
        expect(formatNumberCell("0.0000427777663038", "scientific")).toEqual({ text: "4.3e-5", full: "0.0000427777663038" });
    });

    it("passes a value that is not finite through unchanged", () => {
        expect(formatNumberCell(Number.NaN, "compact")).toEqual({ text: "NaN" });
        expect(formatNumberCell(Number.POSITIVE_INFINITY, "compact")).toEqual({ text: "Infinity" });
    });
});

describe("formatNumberCell determinism", () => {
    it("gives the same text on two calls, and reads no locale", () => {
        const first = formatNumberCell(1234567, "compact");
        const second = formatNumberCell(1234567, "compact");
        expect(first).toEqual(second);
        // The grouping is written in this module. A locale read would give a point or a space on another host.
        expect(first.text).toBe("1,234,567");
    });
});

describe("selectNumberKind", () => {
    it("selects the scientific kind for a p-value column and a value between zero and one", () => {
        expect(selectNumberKind("padj", 0.0001)).toBe("scientific");
        expect(selectNumberKind("pvalue", 0.0001)).toBe("scientific");
        expect(selectNumberKind("fdr", 0.0001)).toBe("scientific");
        expect(selectNumberKind("qval", 0.0001)).toBe("scientific");
    });

    it("reads a p-value token across a separator and across a case boundary", () => {
        expect(selectNumberKind("p_value", 0.02)).toBe("scientific");
        expect(selectNumberKind("padj.BH", 0.02)).toBe("scientific");
        expect(selectNumberKind("padj-BH", 0.02)).toBe("scientific");
        expect(selectNumberKind("pValue", 0.02)).toBe("scientific");
        expect(selectNumberKind("Adjusted p-value", 0.02)).toBe("scientific");
    });

    it("reads a whole token only, thus a bare substring never matches", () => {
        expect(selectNumberKind("expression", 0.42)).toBe("compact-scientific");
        expect(selectNumberKind("proportion", 0.42)).toBe("compact-scientific");
        expect(selectNumberKind("quantile", 0.42)).toBe("compact-scientific");
    });

    it("leaves a p-value column outside the zero-to-one range on the other kinds", () => {
        expect(selectNumberKind("padj", 3)).toBe("compact");
        expect(selectNumberKind("padj", 1)).toBe("compact");
        expect(selectNumberKind("padj", 0)).toBe("compact");
        expect(selectNumberKind("padj", 1.5)).toBe("compact-scientific");
    });

    it("selects the compact kind for an integer", () => {
        expect(selectNumberKind("genes", 14201)).toBe("compact");
        expect(selectNumberKind("genes", -42)).toBe("compact");
    });

    it("selects the compact-scientific kind for every other finite number", () => {
        expect(selectNumberKind("log2FoldChange", -3.089028528355109)).toBe("compact-scientific");
        // An integer above the safe range is no longer exact, thus it reads as a general float.
        expect(selectNumberKind("count", 1e21)).toBe("compact-scientific");
    });

    it("selects the compact-scientific kind for a cell that holds no finite number", () => {
        expect(selectNumberKind("direction", "up")).toBe("compact-scientific");
        expect(selectNumberKind("padj", "")).toBe("compact-scientific");
    });
});
