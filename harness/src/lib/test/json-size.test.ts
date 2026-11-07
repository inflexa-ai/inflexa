import { describe, expect, test } from "bun:test";

import { measureJson } from "../json-size.js";

describe("measureJson", () => {
    test("gives the length of the JSON text of a value with no escapes", () => {
        const value = {
            gene: "TP53",
            scores: [0.1, 2, -3.5, null, true, false],
            nested: { empty: {}, list: [], skipped: undefined },
            when: new Date(0),
            holes: [undefined, () => 1],
        };

        expect(measureJson(value, 1_000)).toEqual({ kind: "within", chars: JSON.stringify(value).length });
    });

    test("stops past the limit", () => {
        expect(measureJson({ blob: "x".repeat(100) }, 50)).toEqual({ kind: "over", limit: 50 });
    });

    test("gives a value that JSON cannot carry as unserializable", () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;

        expect(measureJson({ n: 1n }, 100)).toEqual({ kind: "unserializable", detail: "a bigint has no JSON form" });
        expect(measureJson(cycle, 100)).toEqual({ kind: "unserializable", detail: "the value holds a cycle" });
    });

    test("measures a value that two fields share two times, the way JSON writes it", () => {
        const shared = { a: 1 };
        const value = { left: shared, right: shared };

        expect(measureJson(value, 1_000)).toEqual({ kind: "within", chars: JSON.stringify(value).length });
    });

    test("leaves out the symbol keys", () => {
        const value = { a: "b", [Symbol("record")]: { large: "x".repeat(1_000) } };

        expect(measureJson(value, 100)).toEqual({ kind: "within", chars: JSON.stringify(value).length });
    });
});
