import { describe, expect, it } from "bun:test";

import { coverageFromFilteredRows } from "./coverage.js";

describe("coverageFromFilteredRows", () => {
    const filter = "below the pchembl floor";
    const emptyReason = "the source held nothing for this target";

    it("reports filtered, not available, when a filter removed every row", () => {
        expect(
            coverageFromFilteredRows({
                data: { rows: [] },
                retainedCount: 0,
                droppedCount: 7,
                filter,
                emptyReason,
            }),
        ).toEqual({ coverage: "filtered", filter, dropped_count: 7 });
    });

    it("carries no data on the filtered branch, so an emptied section cannot read as populated", () => {
        const section = coverageFromFilteredRows({
            data: { rows: [], excluded_rows: [{ nct_id: "NCT1" }] },
            retainedCount: 0,
            droppedCount: 1,
            filter,
            emptyReason,
        });
        expect("data" in section).toBe(false);
    });

    it("keeps a partially filtered section available but makes it report its own drops", () => {
        expect(
            coverageFromFilteredRows({
                data: { rows: [1, 2] },
                retainedCount: 2,
                droppedCount: 3,
                filter,
                emptyReason,
            }),
        ).toEqual({ coverage: "available", data: { rows: [1, 2] }, dropped_count: 3 });
    });

    it("reports no dropped_count when nothing was filtered, so a clean section stays clean", () => {
        const section = coverageFromFilteredRows({
            data: { rows: [1] },
            retainedCount: 1,
            droppedCount: 0,
            filter,
            emptyReason,
        });
        expect(section).toEqual({ coverage: "available", data: { rows: [1] } });
        expect("dropped_count" in section).toBe(false);
    });

    it("reports queried_no_data when the list was empty before any filter of ours ran", () => {
        expect(
            coverageFromFilteredRows({
                data: { rows: [] },
                retainedCount: 0,
                droppedCount: 0,
                filter,
                emptyReason,
            }),
        ).toEqual({ coverage: "queried_no_data", error: { message: emptyReason } });
    });

    it("distinguishes an empty source from a filter that emptied it, which is the whole point", () => {
        const emptySource = coverageFromFilteredRows({ data: { rows: [] }, retainedCount: 0, droppedCount: 0, filter, emptyReason });
        const emptiedByUs = coverageFromFilteredRows({ data: { rows: [] }, retainedCount: 0, droppedCount: 4, filter, emptyReason });
        expect(emptySource.coverage).not.toBe(emptiedByUs.coverage);
    });
});
