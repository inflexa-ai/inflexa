/**
 * The tests of the table data payload: the columnar encode, the dictionary pass, and the asset name.
 *
 * The decode of the page reads the same shape, thus a test here states what the page script consumes.
 */

import { describe, expect, it } from "bun:test";

import { encodeTablePayload, tableDataAsset, TABLE_DATA_GLOBAL } from "./table-data.js";

describe("encodeTablePayload", () => {
    it("writes each row as an array in column order", () => {
        const payload = encodeTablePayload(
            ["gene", "padj"],
            [
                { gene: "TP53", padj: 0.01 },
                { gene: "MYC", padj: 0.02 },
            ],
        );

        // No row repeats the column names, thus a table of many rows costs one column list.
        expect(payload.columns).toEqual(["gene", "padj"]);
        expect(payload.rows).toEqual([
            ["TP53", 0.01],
            ["MYC", 0.02],
        ]);
        expect(payload.dict).toEqual({});
    });

    it("moves a repeated string of a column into the dictionary, in first-appearance order", () => {
        const rows = [
            { gene: "TP53", direction: "up" },
            { gene: "MYC", direction: "down" },
            { gene: "EGFR", direction: "up" },
            { gene: "KRAS", direction: "down" },
        ];

        const payload = encodeTablePayload(["gene", "direction"], rows);

        // The category column holds two values across four rows, thus it costs two strings and four indexes.
        expect(payload.dict).toEqual({ direction: ["up", "down"] });
        expect(payload.rows).toEqual([
            ["TP53", 0],
            ["MYC", 1],
            ["EGFR", 0],
            ["KRAS", 1],
        ]);
    });

    it("leaves a column of distinct strings raw, because a dictionary would save nothing", () => {
        const payload = encodeTablePayload(["gene"], [{ gene: "TP53" }, { gene: "MYC" }]);

        expect(payload.dict).toEqual({});
        expect(payload.rows).toEqual([["TP53"], ["MYC"]]);
    });

    it("leaves a column that holds a number raw, thus no cell of it reads as an index", () => {
        const payload = encodeTablePayload(["mixed"], [{ mixed: "same" }, { mixed: "same" }, { mixed: 1 }]);

        expect(payload.dict).toEqual({});
        expect(payload.rows).toEqual([["same"], ["same"], [1]]);
    });

    it("keeps a string that occurs one time in its row, because an entry would save nothing", () => {
        const payload = encodeTablePayload(["direction"], [{ direction: "up" }, { direction: "up" }, { direction: "sideways" }]);

        // The dictionary holds the repeated value alone, and the lone value stays where it is.
        expect(payload.dict).toEqual({ direction: ["up"] });
        expect(payload.rows).toEqual([[0], [0], ["sideways"]]);
    });

    it("writes an absent cell as null, thus a ragged row keeps its shape", () => {
        const payload = encodeTablePayload(["gene", "padj"], [{ gene: "TP53", padj: 0.01 }, { gene: "MYC" }]);

        expect(payload.rows).toEqual([
            ["TP53", 0.01],
            ["MYC", null],
        ]);
    });

    it("gives one payload for one table, thus two encodes match", () => {
        const rows = [
            { gene: "TP53", direction: "up" },
            { gene: "MYC", direction: "up" },
        ];

        expect(encodeTablePayload(["gene", "direction"], rows)).toEqual(encodeTablePayload(["gene", "direction"], rows));
    });
});

describe("tableDataAsset", () => {
    const payload = encodeTablePayload(["gene"], [{ gene: "TP53" }]);

    it("registers the payload under the global map, keyed by the block id", () => {
        const asset = tableDataAsset("tbl-1", payload);

        expect(asset.bytes).toContain(`window.${TABLE_DATA_GLOBAL}`);
        expect(asset.bytes).toContain(`[${JSON.stringify("tbl-1")}]=`);
        expect(asset.bytes).toContain(`"columns":["gene"]`);
    });

    it("names the file by the content hash of its bytes", () => {
        const asset = tableDataAsset("tbl-1", payload);

        expect(asset.name).toMatch(/^t-[0-9a-f]{12}\.data\.js$/);
        // The name is the address of the bytes, thus one payload gives one name.
        expect(tableDataAsset("tbl-1", payload).name).toBe(asset.name);
    });

    it("gives a different name to a different payload and to a different block", () => {
        const other = encodeTablePayload(["gene"], [{ gene: "MYC" }]);

        expect(tableDataAsset("tbl-1", other).name).not.toBe(tableDataAsset("tbl-1", payload).name);
        expect(tableDataAsset("tbl-2", payload).name).not.toBe(tableDataAsset("tbl-1", payload).name);
    });

    it("keeps a hostile block id and a hostile cell as data", () => {
        const hostile = encodeTablePayload(["gene"], [{ gene: "</script><script>alert(1)</script>" }]);
        const asset = tableDataAsset("</script>", hostile);

        // The payload rides JSON, and the escape of the sink covers the one sequence that closes an element.
        expect(asset.bytes).not.toContain("</script>");
        expect(asset.bytes).toContain("\\u003c/script>");
    });
});
