/**
 * The coverage gate of the design fixture.
 *
 * A person edits `design.ts` and the views, then examines the fixture page. The page shows only the kinds
 * that the fixture holds. Thus a kind that the fixture omits gets no design and no look, and the omission is
 * silent.
 *
 * This gate closes that hole. The expected kind set derives from the block contract itself, and not from a
 * list in this file. Thus a ninth kind fails this gate until the fixture covers it.
 */

import { describe, expect, it } from "bun:test";

import { ATOM_BLOCK_SCHEMAS, SectionBlockSchema, type Block } from "../contracts/report-blocks.js";
import { FIXTURE_DOCUMENT } from "./fixture.js";

/** Each block kind that the contract declares. The set reads the `kind` literal of each block schema. */
function contractKinds(): string[] {
    const schemas = [SectionBlockSchema, ...ATOM_BLOCK_SCHEMAS];
    return schemas.map((schema) => schema.shape.kind.value);
}

/** Every block of a tree, in document order. A section contributes itself and then its children. */
function everyBlock(blocks: readonly Block[]): Block[] {
    const flat: Block[] = [];
    for (const block of blocks) {
        flat.push(block);
        if (block.kind === "section") {
            flat.push(...everyBlock(block.blocks));
        }
    }
    return flat;
}

/**
 * The length of each consecutive run of metric siblings in a tree. A block of a different kind ends a run,
 * and a nested section contributes the runs of its own children.
 */
function metricRuns(blocks: readonly Block[]): number[] {
    const runs: number[] = [];
    let run = 0;
    for (const block of blocks) {
        if (block.kind === "metric") {
            run += 1;
            continue;
        }
        if (run > 0) runs.push(run);
        run = 0;
        if (block.kind === "section") {
            runs.push(...metricRuns(block.blocks));
        }
    }
    if (run > 0) runs.push(run);
    return runs;
}

describe("the design fixture", () => {
    it("holds one block of each kind that the contract declares", () => {
        const covered = [...new Set(everyBlock(FIXTURE_DOCUMENT.sections).map((block) => block.kind))].sort();
        const declared = [...new Set(contractKinds())].sort();
        // A new kind lands in the contract one time. The fixture must then carry it, otherwise the page that
        // a person examines shows no example of it.
        expect(covered).toEqual(declared);
    });

    it("holds a text block that carries a list", () => {
        const withAList = everyBlock(FIXTURE_DOCUMENT.sections).filter((block) => block.kind === "text" && block.content.list !== undefined);
        // The list is a content form of the text block, and it renders markup of its own. The page shows
        // only what the fixture holds, thus a fixture with no list keeps the list markup out of the design
        // review and out of the HTML validation alike.
        expect(withAList.length).toBeGreaterThan(0);
    });

    it("holds a metric run that the grid groups and a lone metric that it does not", () => {
        const runs = metricRuns(FIXTURE_DOCUMENT.sections);
        // The renderer groups a run of two or more into one grid, and it leaves a lone metric as one card.
        // The fixture must show both forms, otherwise one of the two designs never reaches the page.
        expect(runs.filter((length) => length >= 2).length).toBeGreaterThan(0);
        expect(runs.filter((length) => length === 1).length).toBeGreaterThan(0);
    });
});
