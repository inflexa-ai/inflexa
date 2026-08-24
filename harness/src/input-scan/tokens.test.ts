import { describe, expect, it } from "bun:test";

import { classifyValues, commonAffixes, isDateToken, isOpaqueId, maskAffix, skeletonOf, splitStem, tokenizeName, tokenizeSegment } from "./tokens.js";

describe("splitStem", () => {
    it("keeps a categorical suffix chain in the stem", () => {
        expect(splitStem("specimen__calls.somatic.callerone.vcf.gz")).toEqual({ stem: "specimen__calls.somatic.callerone", suffix: "vcf.gz" });
    });

    it("takes the whole trailing run of recognised extensions", () => {
        expect(splitStem("panel.tsv.gz")).toEqual({ stem: "panel", suffix: "tsv.gz" });
        expect(splitStem("panel")).toEqual({ stem: "panel", suffix: "" });
    });

    it("never reads the whole name as an extension", () => {
        expect(splitStem("csv")).toEqual({ stem: "csv", suffix: "" });
    });
});

describe("isOpaqueId", () => {
    it("recognises machine-issued tokens", () => {
        expect(isOpaqueId("k7Qm2xVb9Lr4Tz8Wp3Ny")).toBe(true);
        expect(isOpaqueId("3f6a1c92-4b0d-4e7f-9a21-8c5d0e1b7a34")).toBe(true);
        expect(isOpaqueId("0123456789abcdef0123456789abcdef")).toBe(true);
    });

    it("leaves a name a person wrote alone", () => {
        expect(isOpaqueId("Specimen_001_Baseline")).toBe(false);
        expect(isOpaqueId("assay_panel_result")).toBe(false);
        expect(isOpaqueId("run12")).toBe(false);
    });
});

describe("isDateToken", () => {
    it("recognises compact and delimited calendar dates", () => {
        expect(isDateToken("20260824")).toBe(true);
        expect(isDateToken("2026-08-24")).toBe(true);
        expect(isDateToken("2026_08_24")).toBe(true);
    });

    it("rejects a number that is merely eight digits long", () => {
        expect(isDateToken("20261324")).toBe(false);
        expect(isDateToken("12345678")).toBe(false);
        expect(isDateToken("2026-08")).toBe(false);
    });
});

describe("tokenizeSegment", () => {
    it("keeps a delimited date whole rather than splitting it into three numbers", () => {
        expect(tokenizeSegment("2026-08-24")).toEqual([{ kind: "date", value: "2026-08-24" }]);
    });

    it("keeps an opaque identifier whole", () => {
        const tokens = tokenizeSegment("k7Qm2xVb9Lr4Tz8Wp3Ny");
        expect(tokens).toHaveLength(1);
        expect(tokens[0]!.kind).toBe("id");
    });

    it("splits a human-written name into its runs", () => {
        expect(tokenizeSegment("specimen_012").map((token) => token.kind)).toEqual(["alpha", "delim", "digit"]);
    });
});

describe("tokenizeName", () => {
    it("makes each dot-part of a suffix chain its own position", () => {
        const { tokens, suffix } = tokenizeName("specimen__calls.somatic.callerone.vcf.gz");
        expect(suffix).toBe("vcf.gz");
        expect(tokens.filter((token) => token.kind === "alpha").map((token) => token.value)).toEqual(["specimen", "calls", "somatic", "callerone"]);
    });

    it("masks variable material out of the skeleton", () => {
        const withId = skeletonOf(tokenizeName("upload_k7Qm2xVb9Lr4Tz8Wp3Ny.csv").tokens);
        const other = skeletonOf(tokenizeName("upload_Zx4Np8Ct2Mv6Bq1Rs5Hd.csv").tokens);
        expect(withId).toBe(other);
    });
});

describe("classifyValues", () => {
    it("reads a set of dates as dates, not as fixed-width digits", () => {
        expect(classifyValues(["20260824", "20260901", "20261015"]).tokenClass).toBe("date");
    });

    it("reports the width of a fixed-width numeric position", () => {
        expect(classifyValues(["001", "002", "017"])).toEqual({ tokenClass: "digits-fixed", width: 3 });
    });

    it("reports a length range for an identifier position", () => {
        const observed = classifyValues(["k7Qm2xVb9Lr4Tz8Wp3Ny", "Zx4Np8Ct2Mv6Bq1Rs5Hd"]);
        expect(observed.tokenClass).toBe("opaque-id");
        expect(observed.minLength).toBe(20);
    });

    it("falls back to a shared masked skeleton before giving up", () => {
        const observed = classifyValues(["t1s2", "t3s4"]);
        expect(observed.tokenClass).toBe("pattern");
        expect(observed.skeleton).toBe("t#s#");
    });

    it("classes a lone identifier as an identifier, not a constant", () => {
        expect(classifyValues(["k7Qm2xVb9Lr4Tz8Wp3Ny"]).tokenClass).toBe("opaque-id");
        expect(classifyValues(["baseline"]).tokenClass).toBe("constant");
    });
});

describe("commonAffixes", () => {
    it("recovers the literal text fused to a varying token", () => {
        expect(commonAffixes(["specimen001_raw", "specimen002_raw"])).toEqual({ prefix: "specimen00", suffix: "_raw" });
    });

    it("reports nothing when the values share nothing", () => {
        expect(commonAffixes(["alpha", "betty"])).toEqual({ prefix: "", suffix: "" });
    });
});

describe("maskAffix", () => {
    it("masks identifier material a shared affix dragged into a template", () => {
        expect(maskAffix("_Ab3Xy_")).toBe("_<x5>_");
        expect(maskAffix("_calls_")).toBe("_calls_");
    });
});
