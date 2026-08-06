/**
 * The tests of the authoring tool surface.
 *
 * Each test drives a tool through `execute` with a minimal tool context. The core operations have their
 * own tests, thus these tests cover the flat-to-core map, the ok-channel refusal, the holder swap, and
 * the isolation of two factories.
 */

import { describe, expect, it } from "bun:test";

import type { DraftDocument } from "../../report-model/draft.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createReportAuthoringTools } from "./authoring-tools.js";

/** An empty snapshot. No test here needs a resolvable artifact, thus the map holds nothing. */
const snapshot: ReportSnapshot = { artifacts: {} };

/** A section with one empty child slot, as a legal draft state. */
function oneSectionDraft(): DraftDocument {
    return { title: "", sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [] }] };
}

describe("add_block", () => {
    it("lands a section on an empty draft, and the outline holds it", async () => {
        const tools = createReportAuthoringTools({ snapshot });
        const { ctx } = makeToolContext();

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(true);
        if (value.applied) {
            expect(value.outline.map((entry) => entry.id)).toEqual(["s1"]);
        }
        expect(tools.currentDraft().sections.map((section) => section.id)).toEqual(["s1"]);
    });

    it("refuses a reference outside the snapshot, and the holder stays unchanged", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();
        const metric = {
            kind: "metric",
            id: "m1",
            label: "count",
            value: { kind: "artifact-value", path: "does/not/exist.csv", hash: "sha256:abc", locator: { column: "n", row: 0 } },
        };

        const result = await tools.add_block.execute({ block: metric, parentId: "s1" }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("unresolved-reference");
        }
        expect(tools.currentDraft().sections).toHaveLength(1);
        expect(tools.currentDraft().sections[0]!.blocks).toEqual([]);
    });

    it("refuses `before` and `after` together, and names the conflict", async () => {
        const tools = createReportAuthoringTools({ snapshot });
        const { ctx } = makeToolContext();

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s2", title: "X", blocks: [] }, before: "a", after: "b" }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("unknown-target");
            expect(value.refusal.detail).toContain("before");
        }
        expect(tools.currentDraft().sections).toEqual([]);
    });
});

describe("change_block", () => {
    it("refuses a change that names neither a title nor a block", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();

        const result = await tools.change_block.execute({ targetId: "s1" }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("payload-kind-mismatch");
        }
    });

    it("refuses a change that names both a title and a block", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();

        const result = await tools.change_block.execute({ targetId: "s1", title: "New", block: { kind: "text", id: "s1", content: { prose: "x" } } }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("payload-kind-mismatch");
        }
    });
});

describe("read_block", () => {
    it("gives `found: false` for an unknown id", async () => {
        const tools = createReportAuthoringTools({ snapshot });
        const { ctx } = makeToolContext();

        const result = await tools.read_block.execute({ id: "nope" }, ctx);

        expect(result._unsafeUnwrap()).toEqual({ found: false });
    });
});

describe("finish_draft", () => {
    it("reports a gap for an empty draft", async () => {
        const tools = createReportAuthoringTools({ snapshot });
        const { ctx } = makeToolContext();

        const result = await tools.finish_draft.execute({}, ctx);

        const value = result._unsafeUnwrap();
        expect(value.valid).toBe(false);
        if (!value.valid) {
            expect(value.gaps.length).toBeGreaterThan(0);
        }
    });

    it("gives the document for a complete draft", async () => {
        const complete: DraftDocument = {
            title: "Report",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "hello" } }] }],
        };
        const tools = createReportAuthoringTools({ snapshot, initialDraft: complete });
        const { ctx } = makeToolContext();

        const result = await tools.finish_draft.execute({}, ctx);

        const value = result._unsafeUnwrap();
        expect(value.valid).toBe(true);
        if (value.valid) {
            expect(value.document).toEqual(complete);
        }
    });
});

describe("factory isolation", () => {
    it("keeps two drafts independent", async () => {
        const first = createReportAuthoringTools({ snapshot });
        const second = createReportAuthoringTools({ snapshot });
        const { ctx } = makeToolContext();

        const added = await first.add_block.execute({ block: { kind: "section", id: "sA", title: "A", blocks: [] } }, ctx);
        expect(added._unsafeUnwrap().applied).toBe(true);

        const firstOutline = (await first.read_outline.execute({}, ctx))._unsafeUnwrap();
        expect(firstOutline.outline.map((entry) => entry.id)).toEqual(["sA"]);

        const secondOutline = (await second.read_outline.execute({}, ctx))._unsafeUnwrap();
        expect(secondOutline.outline).toEqual([]);
        expect(second.currentDraft().sections).toEqual([]);
    });
});
