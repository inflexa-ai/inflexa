/**
 * The authoring tool surface over the draft operations.
 *
 * The factory takes a session-state gateway, and it holds no draft. Each tool reads the thread id from the
 * scope of the call, loads the state of that thread, applies the pure operation, and persists the new
 * document. Thus two threads never share one draft, and a landed document outlives a host restart.
 *
 * Each tool maps its flat input onto a core operation, and it applies the pure operation. A landed
 * document persists before the tool reports `applied: true`. A refused operation returns typed data in the
 * ok channel, and the error channel stays for an unexpected failure.
 *
 * A call with no report thread in its scope, a thread with no stored state, and a gateway fault each
 * refuse as typed data too. That refusal sits beside the core refusal, and it names the absent thread
 * scope or the absent state.
 *
 * The primitive admits a flat object input only. Thus a destination is four optional fields, and not a
 * nested union. A conflict between the flat fields refuses before the core runs.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import type { Scope } from "../../auth/types.js";
import { isSafeId } from "../../workspace/paths.js";
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
import { defineTool, type Tool, type ToolContext, type ToolError } from "../define-tool.js";

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
 * The closed set of tool-layer refusal reasons.
 *
 * `no-thread-scope` means that the scope of the call names no report thread. `absent-state` means that no
 * report session exists for the thread, and it is permanent. `wrong-thread-type` means that the thread is
 * not a report thread, and it is permanent. `scope-analysis-mismatch` means that the scope names one
 * analysis and the thread belongs to another, and it is permanent. `stale-state` means that a concurrent
 * turn landed first, and the agent must read the state again. `state-unavailable` means that the gateway
 * cannot serve or store the state, and it is transient. The set is disjoint from the core
 * `DraftRefusalReason`, thus a reader tells a core refusal from a tool-layer refusal by the reason alone.
 */
export type SessionRefusalReason = "no-thread-scope" | "absent-state" | "wrong-thread-type" | "scope-analysis-mismatch" | "stale-state" | "state-unavailable";

/**
 * A refusal that the tool layer raises before the core runs.
 *
 * The core refuses a bad edit. This layer refuses a call that names no thread, a thread with no stored
 * state, or a gateway that cannot give the state. It sits beside the core `DraftRefusal`, and it never
 * widens the closed reason set of the core.
 */
export interface SessionRefusal {
    reason: SessionRefusalReason;
    detail: string;
}

/**
 * The result of a mutation tool. A refusal carries the typed reason, from the core or from the tool layer.
 *
 * A landing carries the child order of each container that it changed, and not the whole outline. A whole
 * outline costs the size of the draft on every landing, thus composing a report of n blocks would spend
 * n-squared outline entries of agent context to author it. Only the container that the operation touched
 * can surprise the agent: it chose the id, and the rest of the tree did not move. `read_outline` stays
 * the way to read the whole draft, and it costs one call when the agent wants one.
 *
 * A move across two containers reports both. An operation that changes no child order reports none.
 */
export type MutationResult = { applied: true; changed: ChangedContainer[] } | { applied: false; refusal: DraftRefusal | SessionRefusal };

/** The result of `read_outline`. A load that gives no state refuses instead of an outline. */
export type OutlineResult = { outline: OutlineEntry[] } | { refused: SessionRefusal };

/**
 * The result of `read_block`. An absent block is an expected outcome, thus it stays in the ok channel. A
 * load that gives no state refuses instead of a block.
 */
export type ReadBlockResult = { found: true; block: ReadableBlock } | { found: false } | { refused: SessionRefusal };

/** The result of `finish_draft`. A load that gives no state refuses instead of a finish outcome. */
export type FinishToolResult = FinishResult | { refused: SessionRefusal };

/** The state of one report thread: the document under composition, and the frozen snapshot. */
export interface ReportSessionState {
    readonly document: DraftDocument;
    readonly snapshot: ReportSnapshot;
}

/**
 * The concurrency token that a load hands out and a persist compares against. It is the prior document
 * that the load read, or `null` before the first document lands. The persist lands only when the row still
 * holds it, thus a concurrent turn that landed first turns the next persist into a conflict.
 */
export type SessionStateToken = DraftDocument | null;

/**
 * The outcome of a gateway load. `found` carries the state, the analysis that owns the thread, the
 * concurrency token, and the seen-document hash of the look-before-record rule. `absent` and `wrong-type`
 * are permanent conditions, and `failed` is a transient fault that names its cause.
 *
 * `seenDocumentHash` is the hash that the last eyes capture saw, or `null` before the first look. The record
 * tool compares it against the hash of the current draft, thus a never-seen page and a stale look each
 * refuse.
 */
export type SessionStateLoad =
    | { outcome: "found"; state: ReportSessionState; analysisId: string; token: SessionStateToken; seenDocumentHash: string | null }
    | { outcome: "absent" }
    | { outcome: "wrong-type"; detail: string }
    | { outcome: "failed"; detail: string };

/** The outcome of a gateway persist. `conflict` means that a concurrent turn landed first. */
export type SessionStatePersist = { outcome: "persisted" } | { outcome: "conflict" } | { outcome: "failed"; detail: string };

/**
 * The outcome of a gateway stamp. `stamped` wrote the marker. `absent` means that no row holds the thread.
 * `failed` is a transient store fault that names its cause. Each arm is plain data, thus a stamp never
 * throws for one of them.
 */
export type StampResult = { outcome: "stamped" } | { outcome: "absent" } | { outcome: "failed"; detail: string };

/**
 * The outcome of the seen stamp through the gateway. `stamped` copied a rendered hash onto the seen hash.
 * `no-rendered` means that the row holds no rendered hash to copy, thus no preview stamped one. `absent`
 * means that no row holds the thread. `failed` is a transient store fault that names its cause. Each arm is
 * plain data, thus a stamp never throws for one of them.
 */
export type SeenStampResult = { outcome: "stamped" } | { outcome: "no-rendered" } | { outcome: "absent" } | { outcome: "failed"; detail: string };

/**
 * The session-state gateway that the tools read and write.
 *
 * The tool layer is the one consumer, thus the interface lives here. The interface speaks a plain
 * discriminated value, not a `Result`, because the tools read the outcome as data. The runtime realizes
 * the gateway over the durable store. A load gives the state, a typed absence, or a typed failure. A
 * persist gives success, or a typed failure.
 */
export interface ReportSessionStateGateway {
    load(threadId: string): Promise<SessionStateLoad>;
    persist(threadId: string, document: DraftDocument, expected: SessionStateToken): Promise<SessionStatePersist>;
    /**
     * Stamp the hash of the rendered draft on the session state. The preview calls it when the page lands,
     * thus the runtime knows which draft the page shows.
     */
    stampRendered(threadId: string, hash: string): Promise<StampResult>;
    /**
     * Copy the rendered hash onto the seen hash. The eyes call it after a capture, thus the seen hash holds
     * the hash of the draft that the picture shows, and never the current one. The outcome names whether a
     * rendered hash existed to copy, thus the eyes tell a real stamp from a missed one.
     */
    stampSeen(threadId: string): Promise<SeenStampResult>;
}

/**
 * The thread of a call, its analysis, the loaded state, the concurrency token that the persist compares
 * against, and the seen-document hash of the look-before-record rule.
 */
export interface OpenedThread {
    readonly threadId: string;
    readonly analysisId: string;
    readonly state: ReportSessionState;
    readonly token: SessionStateToken;
    /** The hash that the last eyes capture saw, or `null` before the first look. */
    readonly seenDocumentHash: string | null;
}

/**
 * Resolve the report thread of a call, and load its state through the gateway.
 *
 * The report thread and its analysis ride on the analysis scope. The thread id becomes one segment of a
 * session directory, thus the safe-id check sits here beside the shape check: a scope whose id carries a
 * separator or a traversal segment names no thread that a tool can write under.
 *
 * The stored analysis of the thread must match the scope. A mismatch reads one analysis's draft and writes
 * into another analysis's workspace, thus the resolution refuses it with a permanent reason that names the
 * two ids. A scope of a different kind, an unsafe id, an absent thread, a wrong thread type, and a gateway
 * fault each refuse as a typed `SessionRefusal` too.
 *
 * The authoring tools and the preview tool share this one resolution, thus the two surfaces accept the
 * same thread id and map a load outcome onto a refusal the same way.
 */
export async function openReportThread(gateway: ReportSessionStateGateway, scope: Scope): Promise<Result<OpenedThread, SessionRefusal>> {
    if (scope.kind !== "analysis" || scope.threadId === undefined || !isSafeId(scope.threadId)) {
        return err({ reason: "no-thread-scope", detail: "the scope of the call names no usable report thread id" });
    }
    const { threadId, analysisId } = scope;
    const loaded = await gateway.load(threadId);
    if (loaded.outcome === "absent") {
        return err({ reason: "absent-state", detail: `no report session exists for the thread ${threadId}, and this condition is permanent` });
    }
    if (loaded.outcome === "wrong-type") {
        return err({ reason: "wrong-thread-type", detail: `${loaded.detail}, and this condition is permanent` });
    }
    if (loaded.outcome === "failed") {
        return err({ reason: "state-unavailable", detail: loaded.detail });
    }
    if (loaded.analysisId !== analysisId) {
        return err({
            reason: "scope-analysis-mismatch",
            detail: `the scope names the analysis ${analysisId}, but the thread ${threadId} belongs to the analysis ${loaded.analysisId}`,
        });
    }
    return ok({ threadId, analysisId, state: loaded.state, token: loaded.token, seenDocumentHash: loaded.seenDocumentHash });
}

/** The eight authoring tools. */
export interface ReportAuthoringTools {
    readonly add_block: Tool<AddBlockInput, MutationResult>;
    readonly change_block: Tool<ChangeBlockInput, MutationResult>;
    readonly remove_block: Tool<RemoveBlockInput, MutationResult>;
    readonly move_block: Tool<MoveBlockInput, MutationResult>;
    readonly set_title: Tool<SetTitleInput, MutationResult>;
    readonly read_outline: Tool<ReadOutlineInput, OutlineResult>;
    readonly read_block: Tool<ReadBlockInput, ReadBlockResult>;
    readonly finish_draft: Tool<FinishDraftInput, FinishToolResult>;
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
 * A tool loads the state of its thread, applies the pure operation, and persists the result in one body.
 * The reported outline must agree with the row that the body just wrote. A step-mode tool goes through
 * `DBOS.runStep`, which caches the result of a step and replays it without a fresh load. A replay could
 * then report an outline that the current row no longer holds. Inline mode reads and writes the row in one
 * lifetime, thus the outline never drifts from the state.
 */
const AUTHORING_EXECUTION_MODE = "inline" as const;

/**
 * Make the eight authoring tools over a session-state gateway.
 *
 * Each tool reads the thread id from the scope of the call, and it loads the state of that thread through
 * the gateway. Thus one factory serves every thread, and two threads never share one draft. A mutation
 * persists the new document before it reports `applied: true`, thus a reported landing is never lost.
 */
export function createReportAuthoringTools(gateway: ReportSessionStateGateway): ReportAuthoringTools {
    /**
     * Resolve the thread of the call, and load its state.
     *
     * The shared `openReportThread` holds the one resolution. A scope of a different kind, an unsafe or
     * absent thread id, an absent row, and a gateway fault each refuse before the call reaches a core
     * operation.
     */
    const openThread = (ctx: ToolContext): Promise<Result<OpenedThread, SessionRefusal>> => openReportThread(gateway, ctx.session.scope);

    /**
     * Persist a landing, and report the containers that the operation changed.
     *
     * `holders` names them by id, and it reads the previous document and the next document, because a
     * removed block has a holder only in the first and an added block has one only in the second. The child
     * order comes out of `next` in either case. A persist fault refuses with `state-unavailable`, thus the
     * tool reports `applied: true` only after the row holds the new document.
     *
     * The persist is a compare-and-swap against the token that the load read. A concurrent turn that landed
     * first turns the persist into a conflict, and the tool refuses with `stale-state`.
     */
    const land = async (
        threadId: string,
        token: SessionStateToken,
        previous: DraftDocument,
        result: Result<DraftDocument, DraftRefusal>,
        holders: (previous: DraftDocument, next: DraftDocument) => (string | undefined)[],
    ): Promise<MutationResult> => {
        if (result.isErr()) {
            return { applied: false, refusal: result.error };
        }
        const next = result.value;
        const persisted = await gateway.persist(threadId, next, token);
        if (persisted.outcome === "conflict") {
            return {
                applied: false,
                refusal: { reason: "stale-state", detail: "another turn changed the report since this turn read it, thus read the state again" },
            };
        }
        if (persisted.outcome === "failed") {
            return { applied: false, refusal: { reason: "state-unavailable", detail: persisted.detail } };
        }
        // A move inside one container names the same holder two times.
        const unique = [...new Set(holders(previous, next))];
        return { applied: true, changed: unique.map((parentId) => containerIn(next, parentId)) };
    };

    const refuse = (refusal: DraftRefusal | SessionRefusal): MutationResult => ({ applied: false, refusal });

    const add_block = defineTool({
        id: "add_block",
        description:
            "Add one block to the draft. The `block` schema gives the eight kinds and the fields of each one. " +
            "You choose the `id` of the block, and it must be unique in the draft. " +
            "Name the destination with `parentId` and one of `place`, `before`, or `after`. " +
            "The root admits a section only, and an atom needs a section as its parent. " +
            "A reference names the path of a pinned artifact, and the session stamps the hash from the pinned evidence.",
        inputSchema: addBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => {
            const kind = readKind(decodeBlockPayload(input.block));
            return kind !== undefined ? `add ${kind}` : "add a block";
        },
        execute: async (input, ctx): Promise<Result<MutationResult, ToolError>> => {
            const opened = await openThread(ctx);
            if (opened.isErr()) {
                return ok(refuse(opened.error));
            }
            const { threadId, state, token } = opened.value;
            const destination = toDestination(input);
            if (destination.isErr()) {
                return ok(refuse(destination.error));
            }
            const block = decodeBlockPayload(input.block);
            const addedId = readId(block);
            return ok(
                await land(
                    threadId,
                    token,
                    state.document,
                    addBlock(state.document, { block, destination: destination.value }, state.snapshot),
                    (_previous, next) => [addedId === undefined ? undefined : holderIdOf(next, addedId)],
                ),
            );
        },
    });

    const change_block = defineTool({
        id: "change_block",
        description:
            "Change one block by its id. Give a `title` to retitle a section, or a `block` to replace an atom, and never both. " +
            "The change keeps the id of the target, thus the `id` of the payload does not matter. A kind change is permitted. " +
            "A reference names the path of a pinned artifact, and the session stamps the hash from the pinned evidence.",
        inputSchema: changeBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => `change ${input.targetId}`,
        execute: async (input, ctx): Promise<Result<MutationResult, ToolError>> => {
            const opened = await openThread(ctx);
            if (opened.isErr()) {
                return ok(refuse(opened.error));
            }
            const { threadId, state, token } = opened.value;
            const operation = toChangeOperation(input);
            if (operation.isErr()) {
                return ok(refuse(operation.error));
            }
            return ok(
                await land(threadId, token, state.document, changeBlock(state.document, operation.value, state.snapshot), (_previous, next) => [
                    holderIdOf(next, input.targetId),
                ]),
            );
        },
    });

    const remove_block = defineTool({
        id: "remove_block",
        description: "Remove one block by its id. A removed section takes its whole subtree with it, and the id is free for a later add.",
        inputSchema: removeBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => `remove ${input.targetId}`,
        execute: async (input, ctx): Promise<Result<MutationResult, ToolError>> => {
            const opened = await openThread(ctx);
            if (opened.isErr()) {
                return ok(refuse(opened.error));
            }
            const { threadId, state, token } = opened.value;
            return ok(
                await land(threadId, token, state.document, removeBlock(state.document, { targetId: input.targetId }, state.snapshot), (previous) => [
                    holderIdOf(previous, input.targetId),
                ]),
            );
        },
    });

    const move_block = defineTool({
        id: "move_block",
        description:
            "Move one block by its id to a new destination. Name the destination with `parentId` and one of `place`, `before`, or `after`. " +
            "A section cannot move into its own subtree.",
        inputSchema: moveBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => `move ${input.targetId}`,
        execute: async (input, ctx): Promise<Result<MutationResult, ToolError>> => {
            const opened = await openThread(ctx);
            if (opened.isErr()) {
                return ok(refuse(opened.error));
            }
            const { threadId, state, token } = opened.value;
            const destination = toDestination(input);
            if (destination.isErr()) {
                return ok(refuse(destination.error));
            }
            return ok(
                await land(
                    threadId,
                    token,
                    state.document,
                    moveBlock(state.document, { targetId: input.targetId, destination: destination.value }, state.snapshot),
                    (previous, next) => [holderIdOf(previous, input.targetId), holderIdOf(next, input.targetId)],
                ),
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
        execute: async (input, ctx): Promise<Result<MutationResult, ToolError>> => {
            const opened = await openThread(ctx);
            if (opened.isErr()) {
                return ok(refuse(opened.error));
            }
            const { threadId, state, token } = opened.value;
            return ok(await land(threadId, token, state.document, ok(setTitle(state.document, input.title)), () => []));
        },
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
        execute: async (_input, ctx): Promise<Result<OutlineResult, ToolError>> => {
            const opened = await openThread(ctx);
            if (opened.isErr()) {
                return ok({ refused: opened.error });
            }
            return ok({ outline: buildOutline(opened.value.state.document) });
        },
    });

    const read_block = defineTool({
        id: "read_block",
        description:
            "Read one block by its id. An atom gives the full block with its bindings. A section gives its title and the id of each child, " +
            "because the outline already names every block under it. Use it when the outline label is not enough.",
        inputSchema: readBlockInput,
        executionMode: AUTHORING_EXECUTION_MODE,
        describeCall: (input): string => `read ${input.targetId}`,
        execute: async (input, ctx): Promise<Result<ReadBlockResult, ToolError>> => {
            const opened = await openThread(ctx);
            if (opened.isErr()) {
                return ok({ refused: opened.error });
            }
            const block = readBlock(opened.value.state.document, input.targetId);
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
        execute: async (_input, ctx): Promise<Result<FinishToolResult, ToolError>> => {
            const opened = await openThread(ctx);
            if (opened.isErr()) {
                return ok({ refused: opened.error });
            }
            return ok(finishDraft(opened.value.state.document, opened.value.state.snapshot));
        },
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
    };
}
