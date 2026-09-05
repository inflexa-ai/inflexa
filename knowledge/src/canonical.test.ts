import { describe, expect, it } from "bun:test";

import { canonicalize, claimId, contentDigest } from "./canonical.js";

describe("canonicalize", () => {
    it("sorts keys, drops undefined, and keeps arrays in order", () => {
        expect(canonicalize({ b: 1, a: [3, { z: true, y: null }], c: undefined })).toBe('{"a":[3,{"y":null,"z":true}],"b":1}');
    });
    it("gives one digest for two orderings of one record", () => {
        expect(contentDigest({ a: 1, b: "x" })).toBe(contentDigest({ b: "x", a: 1 }));
        expect(contentDigest({ a: 1 })).not.toBe(contentDigest({ a: 2 }));
    });
    it("forms the claim id from the rule id and the first four hex digits", () => {
        expect(claimId("R-0031", "sha256:e7d0ffff")).toBe("R-0031@e7d0");
    });
});
