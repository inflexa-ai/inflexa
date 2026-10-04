import { describe, expect, test } from "bun:test";

import fixture from "./__fixtures__/spdx-expressions.json" with { type: "json" };
import { KNOWN_SPDX, KNOWN_SPDX_EXCEPTIONS, spdxValid } from "./spdx.ts";

// The Python copy of the check (images/sbom/sbom_common.py) reads the same fixture in
// images/sbom/test_sbom_common.py. A change to one copy that the other does not get fails one of the two suites.
describe("spdx — the conformance fixture", () => {
    test("the known ids are exactly the ids of the fixture", () => {
        expect([...KNOWN_SPDX].sort()).toEqual([...fixture.known_ids].sort());
    });

    test("the known exceptions are exactly the exceptions of the fixture", () => {
        expect([...KNOWN_SPDX_EXCEPTIONS].sort()).toEqual([...fixture.known_exceptions].sort());
    });

    test("each case of the fixture gets its answer", () => {
        const wrong = fixture.cases.filter((entry) => spdxValid(entry.value) !== entry.valid).map((entry) => `${JSON.stringify(entry.value)} (${entry.note})`);
        expect(wrong).toEqual([]);
    });

    test("each known id is a valid expression alone", () => {
        expect(fixture.known_ids.filter((id) => !spdxValid(id))).toEqual([]);
    });
});
