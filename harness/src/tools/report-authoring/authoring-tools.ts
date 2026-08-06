/**
 * The authoring tool surface over the draft operations.
 *
 * The factory closes over a private draft holder and the pinned snapshot. It gives seven tools and a
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
    moveBlock,
    removeBlock,
    type ChangeOperation,
    type DraftDestination,
    type DraftPlace,
    type DraftRefusal,
} from "../../report-model/draft-operations.js";
import { buildOutline, readBlock, type OutlineEntry } from "../../report-model/draft-read.js";
import { finishDraft, type FinishResult } from "../../report-model/draft-finish.js";
import type { DraftBlock, DraftDocument } from "../../report-model/draft.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";

/**
 * The block payload is untyped JSON from the model. The core parses it with the draft grammar, and it
 * refuses `malformed-block`. Thus the input schema keeps the payload loose, and the grammar keeps one
 * definition.
 */
const blockPayload = z.unknown();

/** The flat destination fields. An anchor is `before` or `after`, and a place is `start` or `end`. */
const addBlockInput = z.object({
    block: blockPayload,
    parentId: z.string().optional(),
    place: z.enum(["start", "end"]).optional(),
    before: z.string().optional(),
    after: z.string().optional(),
});

/** The change payload is a title for a section target, or a block for an atom target, and exactly one of the two. */
const changeBlockInput = z.object({
    targetId: z.string(),
    title: z.string().optional(),
    block: blockPayload,
});

const removeBlockInput = z.object({
    targetId: z.string(),
});

const moveBlockInput = z.object({
    targetId: z.string(),
    parentId: z.string().optional(),
    place: z.enum(["start", "end"]).optional(),
    before: z.string().optional(),
    after: z.string().optional(),
});

const readOutlineInput = z.object({});

const readBlockInput = z.object({
    id: z.string(),
});

const finishDraftInput = z.object({});

export type AddBlockInput = z.infer<typeof addBlockInput>;
export type ChangeBlockInput = z.infer<typeof changeBlockInput>;
export type RemoveBlockInput = z.infer<typeof removeBlockInput>;
export type MoveBlockInput = z.infer<typeof moveBlockInput>;
export type ReadOutlineInput = z.infer<typeof readOutlineInput>;
export type ReadBlockInput = z.infer<typeof readBlockInput>;
export type FinishDraftInput = z.infer<typeof finishDraftInput>;

/** The result of a mutation tool. A landing carries the fresh outline. A refusal carries the typed reason. */
export type MutationResult = { applied: true; outline: OutlineEntry[] } | { applied: false; refusal: DraftRefusal };

/** The result of `read_outline`. */
export interface OutlineResult {
    outline: OutlineEntry[];
}

/** The result of `read_block`. An absent block is an expected outcome, thus it stays in the ok channel. */
export type ReadBlockResult = { found: true; block: DraftBlock } | { found: false };

/** The state that the factory closes over. */
export interface ReportAuthoringState {
    readonly snapshot: ReportSnapshot;
    /** The draft to start from. The default is an empty draft. */
    readonly initialDraft?: DraftDocument;
}

/** The seven authoring tools, plus a read of the current draft. */
export interface ReportAuthoringTools {
    readonly add_block: Tool<AddBlockInput, MutationResult>;
    readonly change_block: Tool<ChangeBlockInput, MutationResult>;
    readonly remove_block: Tool<RemoveBlockInput, MutationResult>;
    readonly move_block: Tool<MoveBlockInput, MutationResult>;
    readonly read_outline: Tool<ReadOutlineInput, OutlineResult>;
    readonly read_block: Tool<ReadBlockInput, ReadBlockResult>;
    readonly finish_draft: Tool<FinishDraftInput, FinishResult>;
    currentDraft(): DraftDocument;
}

/** The flat fields that name a destination. Both `add_block` and `move_block` carry them. */
interface DestinationInput {
    parentId?: string;
    place?: "start" | "end";
    before?: string;
    after?: string;
}

/**
 * Map the flat destination fields onto the core destination.
 *
 * Two anchors, or an anchor beside a place, name two places at one time. Thus the map refuses with
 * `unknown-target`, and the detail names the conflict. An anchor implies its own parent, thus a place
 * beside an anchor is a contradiction and not a refinement.
 */
function toDestination(input: DestinationInput): Result<DraftDestination, DraftRefusal> {
    const { parentId, place, before, after } = input;
    if (before !== undefined && after !== undefined) {
        return err({ reason: "unknown-target", detail: "a destination names `before` or `after`, not both" });
    }
    const hasAnchor = before !== undefined || after !== undefined;
    if (hasAnchor && place !== undefined) {
        return err({ reason: "unknown-target", detail: "a destination names an anchor or a `place`, not both" });
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
    if (input.title !== undefined && input.block !== undefined) {
        return err({ reason: "payload-kind-mismatch", detail: "a change names a `title` or a `block`, not both" });
    }
    if (input.title !== undefined) {
        return ok({ targetId: input.targetId, title: input.title });
    }
    if (input.block !== undefined) {
        return ok({ targetId: input.targetId, block: input.block });
    }
    return err({ reason: "payload-kind-mismatch", detail: "a change names a `title` or a `block`" });
}

/** Read the `kind` of an untyped block payload, or `undefined` when the payload names none. */
function readKind(block: unknown): string | undefined {
    if (block !== null && typeof block === "object") {
        const kind = (block as { kind?: unknown }).kind;
        if (typeof kind === "string") {
            return kind;
        }
    }
    return undefined;
}

/**
 * Make the seven authoring tools over one draft.
 *
 * The holder is a private `let`. Each tool reads the holder at call time, thus a landing through one tool
 * shows in the next call of every tool. The holder swaps only inside `land`, thus a refused operation
 * leaves the draft as it was.
 */
export function createReportAuthoringTools(state: ReportAuthoringState): ReportAuthoringTools {
    const snapshot = state.snapshot;
    let draft: DraftDocument = state.initialDraft ?? { title: "", sections: [] };

    const land = (result: Result<DraftDocument, DraftRefusal>): MutationResult =>
        result.match<MutationResult, MutationResult>(
            (next): MutationResult => {
                draft = next;
                return { applied: true, outline: buildOutline(next) };
            },
            (refusal): MutationResult => ({ applied: false, refusal }),
        );

    const refuse = (refusal: DraftRefusal): MutationResult => ({ applied: false, refusal });

    const add_block = defineTool({
        id: "add_block",
        description:
            "Add one block to the draft. Name the destination with `parentId` and one of `place`, `before`, or `after`. " +
            "The root admits a section only, and an atom needs a section as its parent.",
        inputSchema: addBlockInput,
        describeCall: (input): string => {
            const kind = readKind(input.block);
            return kind !== undefined ? `add ${kind}` : "add a block";
        },
        execute: async (input): Promise<Result<MutationResult, ToolError>> => {
            const destination = toDestination(input);
            if (destination.isErr()) {
                return ok(refuse(destination.error));
            }
            return ok(land(addBlock(draft, { block: input.block, destination: destination.value }, snapshot)));
        },
    });

    const change_block = defineTool({
        id: "change_block",
        description:
            "Change one block by its id. Give a `title` to retitle a section, or a `block` to replace an atom. " +
            "The change keeps the id of the target, and a kind change is permitted.",
        inputSchema: changeBlockInput,
        describeCall: (input): string => `change ${input.targetId}`,
        execute: async (input): Promise<Result<MutationResult, ToolError>> => {
            const operation = toChangeOperation(input);
            if (operation.isErr()) {
                return ok(refuse(operation.error));
            }
            return ok(land(changeBlock(draft, operation.value, snapshot)));
        },
    });

    const remove_block = defineTool({
        id: "remove_block",
        description: "Remove one block by its id. A removed section takes its whole subtree with it, and the id is free for a later add.",
        inputSchema: removeBlockInput,
        describeCall: (input): string => `remove ${input.targetId}`,
        execute: async (input): Promise<Result<MutationResult, ToolError>> => ok(land(removeBlock(draft, { targetId: input.targetId }, snapshot))),
    });

    const move_block = defineTool({
        id: "move_block",
        description:
            "Move one block by its id to a new destination. Name the destination with `parentId` and one of `place`, `before`, or `after`. " +
            "A section cannot move into its own subtree.",
        inputSchema: moveBlockInput,
        describeCall: (input): string => `move ${input.targetId}`,
        execute: async (input): Promise<Result<MutationResult, ToolError>> => {
            const destination = toDestination(input);
            if (destination.isErr()) {
                return ok(refuse(destination.error));
            }
            return ok(land(moveBlock(draft, { targetId: input.targetId, destination: destination.value }, snapshot)));
        },
    });

    const read_outline = defineTool({
        id: "read_outline",
        description:
            "Read the outline of the draft. Each entry gives the id, the kind, the nesting depth, and a short label. " +
            "Use the outline as the working view of the draft, and read one block when the label is not enough.",
        inputSchema: readOutlineInput,
        // The input carries no field, thus a hook can only restate the name of the tool.
        describeCall: "none",
        execute: async (): Promise<Result<OutlineResult, ToolError>> => ok({ outline: buildOutline(draft) }),
    });

    const read_block = defineTool({
        id: "read_block",
        description: "Read one block by its id. The result gives the full block with its bindings. Use it when the outline label is not enough.",
        inputSchema: readBlockInput,
        describeCall: (input): string => `read ${input.id}`,
        execute: async (input): Promise<Result<ReadBlockResult, ToolError>> => {
            const block = readBlock(draft, input.id);
            const result: ReadBlockResult = block !== undefined ? { found: true, block } : { found: false };
            return ok(result);
        },
    });

    const finish_draft = defineTool({
        id: "finish_draft",
        description:
            "Finish the draft. The result gives each completeness gap, or the valid report document. " +
            "Use it to check that the draft passes the whole document schema, the id rule, and the structural tier.",
        inputSchema: finishDraftInput,
        // The input carries no field, thus a hook can only restate the name of the tool.
        describeCall: "none",
        execute: async (): Promise<Result<FinishResult, ToolError>> => ok(finishDraft(draft, snapshot)),
    });

    return {
        add_block,
        change_block,
        remove_block,
        move_block,
        read_outline,
        read_block,
        finish_draft,
        currentDraft: (): DraftDocument => draft,
    };
}
