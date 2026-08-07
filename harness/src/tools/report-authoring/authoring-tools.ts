/**
 * The authoring tool surface over the draft operations.
 *
 * The factory closes over a private draft holder and the pinned snapshot. It gives eight tools and a
 * read of the current draft. The tools read no ambient state, thus two factories hold two independent
 * drafts.
 *
 * Each tool maps its flat input onto a core operation, and it applies the pure operation. The holder
 * swaps only on a landed operation. A refused operation returns typed data in the ok channel, and the
 * error channel stays for an unexpected failure.
 *
 * The primitive admits a flat object input only. Thus a destination is four optional fields, and not a
 * nested union. A conflict between the flat fields refuses before the core runs.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import {
    addBlock,
    changeBlock,
    locate,
    moveBlock,
    removeBlock,
    setTitle,
    type ChangeOperation,
    type DraftDestination,
    type DraftPlace,
    type DraftRefusal,
} from "../../report-model/draft-operations.js";
import { buildOutline, childOutline, readBlock, type OutlineEntry, type ReadableBlock } from "../../report-model/draft-read.js";
import { finishDraft, type FinishResult } from "../../report-model/draft-finish.js";
import { DraftBlockSchema, type DraftDocument } from "../../report-model/draft.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";

/**
 * The block payload.
 *
 * The published JSON Schema carries the whole draft grammar, because a tool is self-describing at attach
 * time and the schema is the only place where the model learns the shape of the eight block kinds. A bare
 * `z.unknown()` emits the empty schema, which tells the model nothing and leaves it to discover each
 * required field through one refusal at a time.
 *
 * The `z.unknown()` member keeps the runtime parse permissive. Thus a malformed payload still reaches the
 * core, which parses it with the same grammar and refuses `malformed-block` as typed data in the ok
 * channel. A strict input schema would turn that designed refusal into a hard input-validation error from
 * the loop.
 */
const blockPayload = z.union([DraftBlockSchema, z.unknown()]);

/**
 * A flat field that the model can leave out.
 *
 * Nullish, and not optional. A model that must choose one of four destination fields routinely sends
 * `null` for the three it does not use, and strict function calling requires every declared key to be
 * present. Under `.optional()` each of those nulls fails the input parse, and the block never lands.
 */
const absentable = <T extends z.ZodType>(schema: T): z.ZodOptional<z.ZodNullable<T>> => schema.nullish();

/** The flat destination fields. An anchor is `before` or `after`, and a place is `start` or `end`. */
const addBlockInput = z.object({
    block: blockPayload,
    parentId: absentable(z.string()),
    place: absentable(z.enum(["start", "end"])),
    before: absentable(z.string()),
    after: absentable(z.string()),
});

/**
 * The change payload is a title for a section target, or a block for an atom target, and exactly one of
 * the two. Both fields are absentable, because a section retitle names no block. Zod 4 treats a bare
 * `z.unknown()` as a required key, thus an optional marker is what makes the retitle call representable.
 */
const changeBlockInput = z.object({
    targetId: z.string(),
    title: absentable(z.string()),
    block: blockPayload.optional(),
});

const removeBlockInput = z.object({
    targetId: z.string(),
});

const moveBlockInput = z.object({
    targetId: z.string(),
    parentId: absentable(z.string()),
    place: absentable(z.enum(["start", "end"])),
    before: absentable(z.string()),
    after: absentable(z.string()),
});

const readOutlineInput = z.object({});

/** The read names its target with the same field name as each mutation, thus one id key serves them all. */
const readBlockInput = z.object({
    targetId: z.string(),
});

const setTitleInput = z.object({
    title: z.string().min(1),
});

const finishDraftInput = z.object({});

export type AddBlockInput = z.infer<typeof addBlockInput>;
export type ChangeBlockInput = z.infer<typeof changeBlockInput>;
export type RemoveBlockInput = z.infer<typeof removeBlockInput>;
export type MoveBlockInput = z.infer<typeof moveBlockInput>;
export type ReadOutlineInput = z.infer<typeof readOutlineInput>;
export type ReadBlockInput = z.infer<typeof readBlockInput>;
export type SetTitleInput = z.infer<typeof setTitleInput>;
export type FinishDraftInput = z.infer<typeof finishDraftInput>;

/** One container that an operation changed, and the child order inside it after the operation. */
export interface ChangedContainer {
    /** The section that holds the children. It is absent when the container is the root. */
    parentId?: string;
    children: OutlineEntry[];
}

/**
 * The result of a mutation tool. A refusal carries the typed reason.
 *
 * A landing carries the child order of each container that it changed, and not the whole outline. A whole
 * outline costs the size of the draft on every landing, thus composing a report of n blocks would spend
 * n-squared outline entries of agent context to author it. Only the container that the operation touched
 * can surprise the agent: it chose the id, and the rest of the tree did not move. `read_outline` stays
 * the way to read the whole draft, and it costs one call when the agent wants one.
 *
 * A move across two containers reports both. An operation that changes no child order reports none.
 */
export type MutationResult = { applied: true; changed: ChangedContainer[] } | { applied: false; refusal: DraftRefusal };

/** The result of `read_outline`. */
export interface OutlineResult {
    outline: OutlineEntry[];
}

/** The result of `read_block`. An absent block is an expected outcome, thus it stays in the ok channel. */
export type ReadBlockResult = { found: true; block: ReadableBlock } | { found: false };

/** The state that the factory closes over. */
export interface ReportAuthoringState {
    readonly snapshot: ReportSnapshot;
    /** The draft to start from. The default is an empty draft. */
    readonly initialDraft?: DraftDocument;
}

/** The eight authoring tools, plus a read of the current draft. */
export interface ReportAuthoringTools {
    readonly add_block: Tool<AddBlockInput, MutationResult>;
    readonly change_block: Tool<ChangeBlockInput, MutationResult>;
    readonly remove_block: Tool<RemoveBlockInput, MutationResult>;
    readonly move_block: Tool<MoveBlockInput, MutationResult>;
    readonly set_title: Tool<SetTitleInput, MutationResult>;
    readonly read_outline: Tool<ReadOutlineInput, OutlineResult>;
    readonly read_block: Tool<ReadBlockInput, ReadBlockResult>;
    readonly finish_draft: Tool<FinishDraftInput, FinishResult>;
    currentDraft(): DraftDocument;
}

/** The flat fields that name a destination. Both `add_block` and `move_block` carry them. */
interface DestinationInput {
    parentId?: string | null;
    place?: "start" | "end" | null;
    before?: string | null;
    after?: string | null;
}

/** Read an absentable field. An explicit `null` and an omitted key both mean that the model gave no value. */
function given<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
}

/**
 * Map the flat destination fields onto the core destination.
 *
 * Two anchors, or an anchor beside a place, name two places at one time. Thus the map refuses with
 * `conflicting-destination`, and the detail names the conflict. An anchor implies its own parent, thus a
 * place beside an anchor is a contradiction and not a refinement.
 *
 * The reason is not `unknown-target`, which means that no block holds a named id. A conflict is a fault in
 * the shape of the call, and the repair is to drop one field. An agent that reads `unknown-target` instead
 * goes back to the outline for a better id, finds the ids were already correct, and sends the same
 * conflicting pair again.
 */
function toDestination(input: DestinationInput): Result<DraftDestination, DraftRefusal> {
    const parentId = given(input.parentId);
    const place = given(input.place);
    const before = given(input.before);
    const after = given(input.after);
    if (before !== undefined && after !== undefined) {
        return err({ reason: "conflicting-destination", detail: "a destination names `before` or `after`, not both" });
    }
    const hasAnchor = before !== undefined || after !== undefined;
    if (hasAnchor && place !== undefined) {
        return err({ reason: "conflicting-destination", detail: "a destination names an anchor or a `place`, not both" });
    }
    let resolvedPlace: DraftPlace | undefined;
    if (before !== undefined) {
        resolvedPlace = { before };
    } else if (after !== undefined) {
        resolvedPlace = { after };
    } else {
        resolvedPlace = place;
    }
    return ok({ parentId, place: resolvedPlace });
}

/**
 * Map the flat change fields onto the core change operation.
 *
 * A change names a title or a block, and exactly one of the two. Neither field and both fields each name
 * an ambiguous change. Thus the map refuses with `payload-kind-mismatch`.
 */
function toChangeOperation(input: ChangeBlockInput): Result<ChangeOperation, DraftRefusal> {
    const title = given(input.title);
    const block = given(input.block);
    if (title !== undefined && block !== undefined) {
        return err({ reason: "payload-kind-mismatch", detail: "a change names a `title` or a `block`, not both" });
    }
    if (title !== undefined) {
        return ok({ targetId: input.targetId, title });
    }
    if (block !== undefined) {
        return ok({ targetId: input.targetId, block: decodeBlockPayload(block) });
    }
    return err({ reason: "payload-kind-mismatch", detail: "a change names a `title` or a `block`" });
}

/**
 * Give the block payload as the core expects it, and decode a double-encoded one.
 *
 * A model routinely sends a nested object as a `JSON.stringify` string. The loop repairs that at its own
 * input boundary, but only for a schema that rejects the string, and this payload accepts any value so
 * that a malformed block can come back as a typed refusal. Thus the decode happens here. A string that is
 * not JSON passes through as it is, and the core refuses it as a malformed block.
 */
function decodeBlockPayload(block: unknown): unknown {
    if (typeof block !== "string") {
        return block;
    }
    try {
        return JSON.parse(block);
    } catch {
        return block;
    }
}

/** Read the `kind` of an untyped block payload, or `undefined` when the payload names none. */
function readKind(block: unknown): string | undefined {
    return readStringField(block, "kind");
}

/** Read the `id` of an untyped block payload, or `undefined` when the payload names none. */
function readId(block: unknown): string | undefined {
    return readStringField(block, "id");
}

function readStringField(block: unknown, field: "kind" | "id"): string | undefined {
    if (block !== null && typeof block === "object") {
        const value = (block as Record<string, unknown>)[field];
        if (typeof value === "string") {
            return value;
        }
    }
    return undefined;
}

/**
 * The id of the section that holds a block, or `undefined` when the block sits at the root.
 *
 * The two cases are not distinguishable from the value alone, thus a caller that needs to tell "the root"
 * from "no such block" tests the block itself first.
 */
function holderIdOf(document: DraftDocument, blockId: string): string | undefined {
    return locate(document, blockId)?.parent?.id;
}

/** Read the child order of one container out of a document. */
function containerIn(document: DraftDocument, parentId: string | undefined): ChangedContainer {
    if (parentId === undefined) {
        return { children: childOutline(document.sections, 0) };
    }
    const located = locate(document, parentId);
    // A parent id reaches here only from a landed operation, which already resolved it to a section. The
    // empty fall-back keeps the read total rather than asserting that.
    const children = located !== undefined && located.block.kind === "section" ? located.block.blocks : [];
    return { parentId, children: childOutline(children, located?.path.length ?? 0) };
}

/**
 * Every tool of this surface runs inline.
 *
 * The draft is closure memory with no durable backing. A step-mode tool goes through `DBOS.runStep`, which
 * caches the result of a step and replays it without running the body. A replay after a host restart would
 * hand the agent the cached `applied: true` outline of each landed operation while the rebuilt closure
 * holds an empty draft, and the finish would then report an empty document for a report that the
 * transcript shows as complete. Inline mode keeps the tool result and the draft in one lifetime.
 */
const AUTHORING_EXECUTION_MODE = "inline" as const;

/**
 * Make the eight authoring tools over one draft.
 *
 * The holder is a private `let`. Each tool reads the holder at call time, thus a landing through one tool
 * shows in the next call of every tool. The holder swaps only inside `land`, thus a refused operation
 * leaves the draft as it was.
 */
export function createReportAuthoringTools(state: ReportAuthoringState): ReportAuthoringTools {
    const snapshot = state.snapshot;
    let draft: DraftDocument = state.initialDraft ?? { title: "", sections: [] };

    /**
     * Swap the holder on a landing, and report the containers that the operation changed.
     *
     * `holders` names them by id, and it reads the draft as it was and the draft as it becomes, because a
     * removed block has a holder only in the first and an added block has one only in the second. The
     * child order comes out of `next` in either case.
     */
    const land = (
        result: Result<DraftDocument, DraftRefusal>,
        holders: (previous: DraftDocument, next: DraftDocument) => (string | undefined)[],
    ): MutationResult =>
        result.match<MutationResult, MutationResult>(
            (next): MutationResult => {
                const previous = draft;
                draft = next;
                // A move inside one container names the same holder two times.
                const unique = [...new Set(holders(previous, next))];
                return { applied: true, changed: unique.map((parentId) => containerIn(next, parentId)) };
            },
            (refusal): MutationResult => ({ applied: false, refusal }),
        );

    const refuse = (refusal: DraftRefusal): MutationResult => ({ applied: false, refusal });

    const add_block = defineTool({
        id: "add_block",
        description:
            "Add one block to the draft. The `block` schema gives the eight kinds and the fields of each one. " +
            "You choose the `id` of the block, and it must be unique in the draft. " +
            "Name the destination with `parentId` and one of `place`, `before`, or `after`. " +
            "The root admits a section only, and an atom needs a section as its parent.",
        inputSchema: addBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => {
            const kind = readKind(decodeBlockPayload(input.block));
            return kind !== undefined ? `add ${kind}` : "add a block";
        },
        execute: async (input): Promise<Result<MutationResult, ToolError>> => {
            const destination = toDestination(input);
            if (destination.isErr()) {
                return ok(refuse(destination.error));
            }
            const block = decodeBlockPayload(input.block);
            const addedId = readId(block);
            return ok(
                land(addBlock(draft, { block, destination: destination.value }, snapshot), (_previous, next) => [
                    addedId === undefined ? undefined : holderIdOf(next, addedId),
                ]),
            );
        },
    });

    const change_block = defineTool({
        id: "change_block",
        description:
            "Change one block by its id. Give a `title` to retitle a section, or a `block` to replace an atom, and never both. " +
            "The change keeps the id of the target, thus the `id` of the payload does not matter. A kind change is permitted.",
        inputSchema: changeBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => `change ${input.targetId}`,
        execute: async (input): Promise<Result<MutationResult, ToolError>> => {
            const operation = toChangeOperation(input);
            if (operation.isErr()) {
                return ok(refuse(operation.error));
            }
            return ok(land(changeBlock(draft, operation.value, snapshot), (_previous, next) => [holderIdOf(next, input.targetId)]));
        },
    });

    const remove_block = defineTool({
        id: "remove_block",
        description: "Remove one block by its id. A removed section takes its whole subtree with it, and the id is free for a later add.",
        inputSchema: removeBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => `remove ${input.targetId}`,
        execute: async (input): Promise<Result<MutationResult, ToolError>> =>
            ok(land(removeBlock(draft, { targetId: input.targetId }, snapshot), (previous) => [holderIdOf(previous, input.targetId)])),
    });

    const move_block = defineTool({
        id: "move_block",
        description:
            "Move one block by its id to a new destination. Name the destination with `parentId` and one of `place`, `before`, or `after`. " +
            "A section cannot move into its own subtree.",
        inputSchema: moveBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => `move ${input.targetId}`,
        execute: async (input): Promise<Result<MutationResult, ToolError>> => {
            const destination = toDestination(input);
            if (destination.isErr()) {
                return ok(refuse(destination.error));
            }
            return ok(
                land(moveBlock(draft, { targetId: input.targetId, destination: destination.value }, snapshot), (previous, next) => [
                    holderIdOf(previous, input.targetId),
                    holderIdOf(next, input.targetId),
                ]),
            );
        },
    });

    const set_title = defineTool({
        id: "set_title",
        description:
            "Set the title of the report document. A draft starts with no title, and a document needs one. " +
            "The title names the whole report, and it is not the title of a section.",
        inputSchema: setTitleInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => `title the report ${input.title}`,
        // The title sits on the document, thus no container changes its child order.
        execute: async (input): Promise<Result<MutationResult, ToolError>> => ok(land(ok(setTitle(draft, input.title)), () => [])),
    });

    const read_outline = defineTool({
        id: "read_outline",
        description:
            "Read the outline of the draft. Each entry gives the id, the kind, the nesting depth, and a short label. " +
            "A label that ends with the character … is clipped. Use the outline as the primary view of the draft, " +
            "and read one block when the label is not enough.",
        inputSchema: readOutlineInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        // The input carries no field, thus a hook can only restate the name of the tool.
        describeCall: "none",
        execute: async (): Promise<Result<OutlineResult, ToolError>> => ok({ outline: buildOutline(draft) }),
    });

    const read_block = defineTool({
        id: "read_block",
        description:
            "Read one block by its id. An atom gives the full block with its bindings. A section gives its title and the id of each child, " +
            "because the outline already names every block under it. Use it when the outline label is not enough.",
        inputSchema: readBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => `read ${input.targetId}`,
        execute: async (input): Promise<Result<ReadBlockResult, ToolError>> => {
            const block = readBlock(draft, input.targetId);
            const result: ReadBlockResult = block !== undefined ? { found: true, block } : { found: false };
            return ok(result);
        },
    });

    const finish_draft = defineTool({
        id: "finish_draft",
        description:
            "Finish the draft. The result gives each completeness gap, or the valid report document, and each advisory warning. " +
            "Use it to make sure that the draft passes the whole document schema, the id rule, and the structural tier.",
        inputSchema: finishDraftInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        // The input carries no field, thus a hook can only restate the name of the tool.
        describeCall: "none",
        execute: async (): Promise<Result<FinishResult, ToolError>> => ok(finishDraft(draft, snapshot)),
    });

    return {
        add_block,
        change_block,
        remove_block,
        move_block,
        set_title,
        read_outline,
        read_block,
        finish_draft,
        currentDraft: (): DraftDocument => draft,
    };
}
