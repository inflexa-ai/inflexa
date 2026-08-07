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
    it("lands a section on an empty draft, and reports the root container", async () => {
        const tools = createReportAuthoringTools({ snapshot });
        const { ctx } = makeToolContext();

        const result = await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(true);
        if (value.applied) {
            expect(value.changed).toEqual([{ children: [{ id: "s1", kind: "section", depth: 0, label: "Intro" }] }]);
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
            expect(value.refusal.reason).toBe("conflicting-destination");
            expect(value.refusal.detail).toContain("before");
        }
        expect(tools.currentDraft().sections).toEqual([]);
    });

    it("publishes the block grammar in its JSON schema", () => {
        const tools = createReportAuthoringTools({ snapshot });
        const schema = JSON.stringify(tools.add_block.jsonSchema);

        // The model learns the payload shape from the schema alone, thus the eight kinds must be in it.
        for (const kind of ["section", "text", "claim", "metric", "table", "chart", "figure", "citation"]) {
            expect(schema).toContain(`"const":"${kind}"`);
        }
    });

    it("accepts an explicit null in each destination field that the call does not use", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();
        const input = { block: { kind: "text", id: "t1", content: { prose: "x" } }, parentId: "s1", place: null, before: null, after: null };

        // Strict function calling requires every declared key, thus the unused anchors arrive as null.
        expect(tools.add_block.inputSchema.safeParse(input).success).toBe(true);

        const value = (await tools.add_block.execute(input, ctx))._unsafeUnwrap();
        expect(value.applied).toBe(true);
    });

    it("decodes a block payload that arrives as a JSON string", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();
        const encoded = JSON.stringify({ kind: "text", id: "t1", content: { prose: "x" } });

        const value = (await tools.add_block.execute({ block: encoded, parentId: "s1" }, ctx))._unsafeUnwrap();

        expect(value.applied).toBe(true);
        expect(tools.currentDraft().sections[0]!.blocks.map((block) => block.id)).toEqual(["t1"]);
    });
});

describe("change_block", () => {
    it("retitles a section from a call that names no block", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();
        // The loop validates against `inputSchema` before it runs `execute`, thus the retitle call must
        // pass the schema with the `block` key absent.
        const input = JSON.parse('{"targetId":"s1","title":"Results"}') as Record<string, unknown>;
        expect(tools.change_block.inputSchema.safeParse(input).success).toBe(true);

        const value = (await tools.change_block.execute(input, ctx))._unsafeUnwrap();

        expect(value.applied).toBe(true);
        expect(tools.currentDraft().sections[0]!.title).toBe("Results");
    });

    it("retitles a section when the unused block field arrives as null", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();

        const value = (await tools.change_block.execute({ targetId: "s1", title: "Results", block: null }, ctx))._unsafeUnwrap();

        expect(value.applied).toBe(true);
        expect(tools.currentDraft().sections[0]!.title).toBe("Results");
    });

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

describe("remove_block", () => {
    it("lands a removal, and reports the container that the block left", async () => {
        const draft: DraftDocument = {
            title: "",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "x" } }] }],
        };
        const tools = createReportAuthoringTools({ snapshot, initialDraft: draft });
        const { ctx } = makeToolContext();

        const result = await tools.remove_block.execute({ targetId: "t1" }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(true);
        if (value.applied) {
            expect(value.changed).toEqual([{ parentId: "s1", children: [] }]);
        }
    });
});

describe("move_block", () => {
    it("lands a move with a flat anchor, and reports the new child order", async () => {
        const draft: DraftDocument = {
            title: "",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [
                        { kind: "text", id: "t1", content: { prose: "a" } },
                        { kind: "text", id: "t2", content: { prose: "b" } },
                    ],
                },
            ],
        };
        const tools = createReportAuthoringTools({ snapshot, initialDraft: draft });
        const { ctx } = makeToolContext();

        const result = await tools.move_block.execute({ targetId: "t1", after: "t2" }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(true);
        if (value.applied) {
            // The move stays inside one container, thus that container is reported one time.
            expect(value.changed).toHaveLength(1);
            expect(value.changed[0]!.parentId).toBe("s1");
            expect(value.changed[0]!.children.map((entry) => entry.id)).toEqual(["t2", "t1"]);
        }
    });

    it("refuses `before` and `after` together with conflicting-destination", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();

        const result = await tools.move_block.execute({ targetId: "s1", before: "a", after: "b" }, ctx);

        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(false);
        if (!value.applied) {
            expect(value.refusal.reason).toBe("conflicting-destination");
        }
    });
});

describe("set_title", () => {
    it("sets the document title, and the finish then gives the document", async () => {
        const tools = createReportAuthoringTools({ snapshot });
        const { ctx } = makeToolContext();
        await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Intro", blocks: [] } }, ctx);
        await tools.add_block.execute({ block: { kind: "text", id: "t1", content: { prose: "x" } }, parentId: "s1" }, ctx);

        const untitled = (await tools.finish_draft.execute({}, ctx))._unsafeUnwrap();
        expect(untitled.valid).toBe(false);
        if (!untitled.valid) {
            expect(untitled.gaps).toContainEqual({ kind: "schema", path: "title", message: expect.stringContaining(">=1") });
        }

        const set = (await tools.set_title.execute({ title: "Differential expression" }, ctx))._unsafeUnwrap();
        expect(set.applied).toBe(true);

        const titled = (await tools.finish_draft.execute({}, ctx))._unsafeUnwrap();
        expect(titled.valid).toBe(true);
        if (titled.valid) {
            expect(titled.document.title).toBe("Differential expression");
        }
    });
});

describe("read_block", () => {
    it("names its target with the same field as each mutation tool", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();

        const value = (await tools.read_block.execute({ targetId: "s1" }, ctx))._unsafeUnwrap();

        expect(value.found).toBe(true);
        expect(tools.read_block.inputSchema.safeParse({ id: "s1" }).success).toBe(false);
    });

    it("gives a section without its subtree", async () => {
        const draft: DraftDocument = {
            title: "",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "a long body" } }] }],
        };
        const tools = createReportAuthoringTools({ snapshot, initialDraft: draft });
        const { ctx } = makeToolContext();

        const value = (await tools.read_block.execute({ targetId: "s1" }, ctx))._unsafeUnwrap();

        expect(value).toEqual({ found: true, block: { kind: "section", id: "s1", title: "Intro", childIds: ["t1"] } });
    });
});

describe("the tool surface", () => {
    it("runs every tool inline, because the draft is closure memory with no durable backing", () => {
        const tools = createReportAuthoringTools({ snapshot });
        const packaged = [
            tools.add_block,
            tools.change_block,
            tools.remove_block,
            tools.move_block,
            tools.set_title,
            tools.read_outline,
            tools.read_block,
            tools.finish_draft,
        ];

        // A step-mode tool replays its cached result over a rebuilt, empty draft.
        expect(packaged.map((tool) => tool.executionMode)).toEqual(Array(8).fill("inline"));
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

describe("the cost of a landing", () => {
    it("reports the changed container only, and not the whole draft", async () => {
        const tools = createReportAuthoringTools({ snapshot });
        const { ctx } = makeToolContext();
        await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "First", blocks: [] } }, ctx);
        await tools.add_block.execute({ block: { kind: "text", id: "t1", content: { prose: "in the first section" } }, parentId: "s1" }, ctx);
        await tools.add_block.execute({ block: { kind: "section", id: "s2", title: "Second", blocks: [] } }, ctx);

        const result = await tools.add_block.execute({ block: { kind: "text", id: "t2", content: { prose: "x" } }, parentId: "s2" }, ctx);

        // A whole outline would grow with the draft on every landing, thus authoring n blocks would cost
        // n-squared outline entries of agent context.
        const value = result._unsafeUnwrap();
        expect(value.applied).toBe(true);
        if (value.applied) {
            expect(value.changed).toEqual([{ parentId: "s2", children: [{ id: "t2", kind: "text", depth: 1, label: "x" }] }]);
            expect(JSON.stringify(value)).not.toContain("in the first section");
        }
    });

    it("reports both containers of a move across sections, and one for a move inside a section", async () => {
        const draft: DraftDocument = {
            title: "",
            sections: [
                { kind: "section", id: "s1", title: "First", blocks: [{ kind: "text", id: "t1", content: { prose: "a" } }] },
                { kind: "section", id: "s2", title: "Second", blocks: [{ kind: "text", id: "t2", content: { prose: "b" } }] },
            ],
        };
        const tools = createReportAuthoringTools({ snapshot, initialDraft: draft });
        const { ctx } = makeToolContext();

        const across = (await tools.move_block.execute({ targetId: "t1", parentId: "s2", place: "end" }, ctx))._unsafeUnwrap();

        expect(across.applied).toBe(true);
        if (across.applied) {
            expect(across.changed.map((container) => container.parentId)).toEqual(["s1", "s2"]);
            expect(across.changed[0]!.children).toEqual([]);
            expect(across.changed[1]!.children.map((entry) => entry.id)).toEqual(["t2", "t1"]);
        }
    });

    it("reports no container for a title, which changes no child order", async () => {
        const tools = createReportAuthoringTools({ snapshot, initialDraft: oneSectionDraft() });
        const { ctx } = makeToolContext();

        const value = (await tools.set_title.execute({ title: "Report" }, ctx))._unsafeUnwrap();

        expect(value).toEqual({ applied: true, changed: [] });
    });
});
