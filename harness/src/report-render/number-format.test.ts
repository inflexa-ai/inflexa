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

    it("gives a grouped whole number from one thousand up, with the full digits", () => {
        expect(formatNumberCell(15234.7, "compact-scientific")).toEqual({ text: "15,235", full: "15234.7" });
        expect(formatNumberCell(-15234.7, "compact-scientific")).toEqual({ text: "-15,235", full: "-15234.7" });
    });

    it("groups a value that rounds up to one thousand", () => {
        expect(formatNumberCell(999.5, "compact-scientific")).toEqual({ text: "1,000", full: "999.5" });
        expect(formatNumberCell(1000.5, "compact-scientific")).toEqual({ text: "1,001", full: "1000.5" });
    });

    it("keeps the three significant digits under one thousand", () => {
        expect(formatNumberCell(999.4, "compact-scientific")).toEqual({ text: "999", full: "999.4" });
    });

    it("keeps the scientific form from 1e15 up", () => {
        expect(formatNumberCell(1e15, "compact-scientific")).toEqual({ text: "1e15" });
        expect(formatNumberCell(1.234e15, "compact-scientific")).toEqual({ text: "1.23e15", full: "1234000000000000" });
    });
});

describe("formatNumberCell identifier", () => {
    it("gives the digits of an identifier with no grouping and no full form", () => {
        expect(formatNumberCell(31978945, "identifier")).toEqual({ text: "31978945" });
        expect(formatNumberCell("31978945", "identifier")).toEqual({ text: "31978945" });
    });

    it("keeps a leading zero and a non-numeric identifier", () => {
        expect(formatNumberCell("007", "identifier")).toEqual({ text: "007" });
        expect(formatNumberCell("10.1038/nature12345", "identifier")).toEqual({ text: "10.1038/nature12345" });
    });

    it("trims the space around the source text", () => {
        expect(formatNumberCell("  31978945  ", "identifier")).toEqual({ text: "31978945" });
    });

    it("keeps a pmid cell whole, thus the grouping never reaches an identifier column", () => {
        const cell = "31978945";
        expect(formatNumberCell(cell, selectNumberKind("pmid", cell))).toEqual({ text: "31978945" });
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

    it("carries the source text when the shown form drops a leading zero", () => {
        expect(formatNumberCell("007", "compact")).toEqual({ text: "7", full: "007" });
    });

    it("carries the source text when the shown form drops a trailing zero", () => {
        expect(formatNumberCell("1.50", "compact-scientific")).toEqual({ text: "1.5", full: "1.50" });
    });

    it("gives no full form when the grouping is the only difference from the source text", () => {
        expect(formatNumberCell("14201", "compact")).toEqual({ text: "14,201" });
    });

    it("gives no full form when the shown text matches the source text", () => {
        expect(formatNumberCell("2.94", "compact-scientific")).toEqual({ text: "2.94" });
        expect(formatNumberCell("  2.94  ", "compact-scientific")).toEqual({ text: "2.94" });
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
    it("selects the scientific kind for a p-value column and a value under one hundredth", () => {
        expect(selectNumberKind("padj", 0.0001)).toBe("scientific");
        expect(selectNumberKind("pvalue", 0.0001)).toBe("scientific");
        expect(selectNumberKind("fdr", 0.0001)).toBe("scientific");
        expect(selectNumberKind("qval", 0.0001)).toBe("scientific");
    });

    it("reads a p-value token across a separator and across a case boundary", () => {
        expect(selectNumberKind("p_value", 0.002)).toBe("scientific");
        expect(selectNumberKind("padj.BH", 0.002)).toBe("scientific");
        expect(selectNumberKind("padj-BH", 0.002)).toBe("scientific");
        expect(selectNumberKind("pValue", 0.002)).toBe("scientific");
        expect(selectNumberKind("Adjusted p-value", 0.002)).toBe("scientific");
    });

    it("reads a whole token only, thus a bare substring never matches", () => {
        expect(selectNumberKind("expression", 0.42)).toBe("compact-scientific");
        expect(selectNumberKind("proportion", 0.42)).toBe("compact-scientific");
        expect(selectNumberKind("quantile", 0.42)).toBe("compact-scientific");
    });

    it("leaves a p-value column from one hundredth up on the other kinds", () => {
        expect(selectNumberKind("padj", 0.01)).toBe("compact-scientific");
        expect(selectNumberKind("padj", 0.05)).toBe("compact-scientific");
        expect(selectNumberKind("padj", 0.54)).toBe("compact-scientific");
        expect(selectNumberKind("padj", 3)).toBe("compact");
        expect(selectNumberKind("padj", 1)).toBe("compact");
        expect(selectNumberKind("padj", 0)).toBe("compact");
        expect(selectNumberKind("padj", 1.5)).toBe("compact-scientific");
    });

    it("shows a p-value from one hundredth up as a plain decimal with no full form", () => {
        expect(formatNumberCell(0.05, selectNumberKind("padj", 0.05))).toEqual({ text: "0.05" });
        expect(formatNumberCell(0.0123, selectNumberKind("padj", 0.0123))).toEqual({ text: "0.0123" });
        expect(formatNumberCell(0.54, selectNumberKind("padj", 0.54))).toEqual({ text: "0.54" });
    });

    it("shows a p-value under one hundredth in the scientific form", () => {
        expect(formatNumberCell(0.0099, selectNumberKind("padj", 0.0099))).toEqual({ text: "9.9e-3" });
    });

    it("selects the identifier kind for an identifier column", () => {
        expect(selectNumberKind("pmid", 31978945)).toBe("identifier");
        expect(selectNumberKind("gene_id", 7157)).toBe("identifier");
        expect(selectNumberKind("entrez_id", 7157)).toBe("identifier");
        expect(selectNumberKind("geneID", 7157)).toBe("identifier");
        expect(selectNumberKind("taxid", 9606)).toBe("identifier");
        expect(selectNumberKind("doi", "10.1038/nature12345")).toBe("identifier");
        expect(selectNumberKind("Year", 2024)).toBe("identifier");
        expect(selectNumberKind("accession", "GSE12345")).toBe("identifier");
    });

    it("reads a whole identifier token only, thus a bare substring never matches", () => {
        expect(selectNumberKind("identity", 95)).toBe("compact");
        expect(selectNumberKind("yearly", 2024)).toBe("compact");
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
