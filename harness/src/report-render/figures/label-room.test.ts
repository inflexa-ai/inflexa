/**
 * The place of the names that a dense figure draws with a leader line: clear of each other name, of each leader
 * line, and of each point, inside the plot.
 */

import { describe, expect, it } from "bun:test";

import { leaderNameBox, overlaps, placeLeaderNames, type NameFrame, type PlotRange } from "./label-room.js";

/** A plot of 100 by 100 data units drawn at 200 by 100 pixels with text of 10 pixels. One pixel is half a unit on x. */
const PLOT: PlotRange = { x: { min: 0, max: 100 }, y: { min: 0, max: 100 } };
const FRAME: NameFrame = { widthPx: 200, heightPx: 100, textPx: 10 };

describe("placeLeaderNames", () => {
    it("places a name at its first side where nothing covers it", () => {
        const [placed] = placeLeaderNames([{ x: 20, y: 50, text: "Kal1" }], { xs: [20], ys: [50], pointPx: 4 }, PLOT, ["right", "left"], 100, FRAME);
        // The anchor sits one point radius and one gap right of the point: 2 + 4 pixels, which is 3 units.
        expect(placed).toEqual({ x: 23, y: 50, side: "right" });
    });

    it("moves a name off a cluster of points to the next free side", () => {
        const cluster = Array.from({ length: 40 }, (_value, index) => 22 + index / 2);
        const xs = [20, ...cluster];
        const ys = [50, ...cluster.map(() => 50)];
        const [placed] = placeLeaderNames([{ x: 20, y: 50, text: "Kal1" }], { xs, ys, pointPx: 4 }, PLOT, ["right", "left"], 100, FRAME);
        expect(placed).toEqual({ x: 17, y: 50, side: "left" });
    });

    it("keeps two names of neighbor points apart, and keeps the second leader line off the first name", () => {
        const names = [
            { x: 50, y: 50, text: "sesB" },
            { x: 52, y: 51, text: "Hml" },
        ];
        const placed = placeLeaderNames(names, { xs: [50, 52], ys: [50, 51], pointPx: 4 }, PLOT, ["right", "left"], 100, FRAME);
        expect(placed.every((name) => name !== undefined)).toBe(true);
        const [first, second] = placed.map((name, index) => leaderNameBox(name!, names[index].text, PLOT, FRAME));
        expect(overlaps(first, second)).toBe(false);
    });

    it("moves a name over a point near the edge of the plot inside the plot", () => {
        const [placed] = placeLeaderNames([{ x: 1, y: 10, text: "rs657452" }], { xs: [1], ys: [10], pointPx: 4 }, PLOT, ["top"], 100, FRAME);
        // The name is 8 characters of 6 pixels, thus its center sits 24 pixels, or 12 units, from the left edge.
        expect(placed?.side).toBe("top");
        expect(placed?.x).toBe(12);
    });

    it("takes the place that covers the fewest points where no place is free", () => {
        const xs: number[] = [];
        const ys: number[] = [];
        for (let x = 0; x <= 100; x += 1) {
            for (let y = 0; y <= 100; y += 2) {
                xs.push(x);
                ys.push(y);
            }
        }
        const placed = placeLeaderNames([{ x: 50, y: 50, text: "gas" }], { xs, ys, pointPx: 2 }, PLOT, ["right"], 100, FRAME);
        expect(placed[0]?.side).toBe("right");
        expect(placeLeaderNames([{ x: 50, y: 50, text: "gas" }], { xs, ys, pointPx: 2 }, PLOT, ["right"], 100, FRAME)).toEqual(placed);
    });
});
