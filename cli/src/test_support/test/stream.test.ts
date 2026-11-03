import { describe, expect, test } from "bun:test";

import { streamOf } from "../stream.ts";

describe("streamOf", () => {
    test("yields each item in order and then ends", async () => {
        const seen: number[] = [];
        for await (const item of streamOf([1, 2, 3])) seen.push(item);
        expect(seen).toEqual([1, 2, 3]);
    });

    test("ends at once for an empty list", async () => {
        const stream = streamOf<string>([]);
        expect(await stream.next()).toEqual({ done: true, value: undefined });
    });
});
