/**
 * The pure operations that compose a draft report document.
 *
 * An operation takes the draft, an operation value, and the pinned snapshot. It gives a new draft, or a
 * typed refusal in the error channel. It mutates nothing. Thus a refused operation leaves the input draft
 * as it was.
 *
 * An operation validates the delta only. It parses the new payload with the draft grammar. It scans each
 * id of the candidate for a duplicate. It resolves each new reference against the snapshot with the
 * structural tier. The completeness rules gate one time, at the finish.
 *
 * The candidate shares each untouched branch with the input draft. An operation rebuilds only the path to
 * the edit. Thus the input stays intact, and the memory cost stays small.
 *
 * A destination names an anchor, not an index. An index breaks when the tree changes under the agent, and
 * an anchor id stays stable.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import type { Reference, UnresolvedReference } from "../contracts/report-reference.js";
import { DraftBlockSchema, type DraftBlock, type DraftDocument, type DraftSectionBlock } from "./draft.js";
import type { ReportSnapshot } from "./reference-resolver.js";
import { validateReferenceStructure } from "./structural-validation.js";

/** The closed set of refusal reasons. Each operation gives a subset of these. */
export type DraftRefusalReason =
    "malformed-block" | "duplicate-id" | "unknown-target" | "unresolved-reference" | "cycle" | "atom-at-root" | "not-a-section" | "payload-kind-mismatch";

/**
 * A typed refusal. It carries the reason and a prose detail. The `unresolved-reference` reason also
 * carries each reference that the snapshot does not resolve.
 */
export type DraftRefusal =
    | { reason: Exclude<DraftRefusalReason, "unresolved-reference">; detail: string }
    | { reason: "unresolved-reference"; detail: string; unresolved: UnresolvedReference[] };

/** The place inside a parent. The default place is `end`. An anchor names a sibling id. */
export type DraftPlace = "start" | "end" | { before: string } | { after: string };

/** The destination of an add or a move. `parentId` names a section, or the root when it is absent. */
export interface DraftDestination {
    parentId?: string;
    place?: DraftPlace;
}

/** The add operation value. The payload can be an atom, or a section that carries children. */
export interface AddOperation {
    block: unknown;
    destination?: DraftDestination;
}

/**
 * The change operation value. A `title` retitles a section target. A `block` replaces an atom target.
 * The operation stamps the target id on the block, thus an id mismatch is unrepresentable.
 */
export type ChangeOperation = {
    targetId: string;
} & ({ title: string } | { block: unknown });

/** The remove operation value. It names one block by its id. */
export interface RemoveOperation {
    targetId: string;
}

/** The move operation value. It names one block, and a destination with the shape of the add destination. */
export interface MoveOperation {
    targetId: string;
    destination?: DraftDestination;
}

/**
 * Add a block at a destination.
 *
 * The root admits a section only, thus an atom at the root refuses. The validation covers the payload and
 * each of its descendants.
 */
export function addBlock(draft: DraftDocument, operation: AddOperation, snapshot: ReportSnapshot): Result<DraftDocument, DraftRefusal> {
    const parsed = DraftBlockSchema.safeParse(operation.block);
    if (!parsed.success) {
        return err(malformed(parsed.error));
    }
    const block = parsed.data;
    return resolveDestination(draft, operation.destination).andThen((destination): Result<DraftDocument, DraftRefusal> => {
        if (destination.parentIsRoot && block.kind !== "section") {
            return err({ reason: "atom-at-root", detail: `a ${block.kind} block cannot sit at the root` });
        }
        const candidate = insertAt(draft, destination.containerPath, destination.index, block);
        return commit(candidate, collectReferences(block), snapshot);
    });
}

/**
 * Change one block by its id.
 *
 * A section target takes a title, and its children stay as they are. An atom target takes a full block,
 * and a kind change is permitted. A payload that does not match the target kind refuses.
 */
export function changeBlock(draft: DraftDocument, operation: ChangeOperation, snapshot: ReportSnapshot): Result<DraftDocument, DraftRefusal> {
    const target = locate(draft, operation.targetId);
    if (target === undefined) {
        return err({ reason: "unknown-target", detail: `no block holds the id ${operation.targetId}` });
    }
    const containerPath = target.path.slice(0, -1);
    const index = target.path[target.path.length - 1];

    if (target.block.kind === "section") {
        if (!("title" in operation)) {
            return err({ reason: "payload-kind-mismatch", detail: `the section ${operation.targetId} takes a title, not a block payload` });
        }
        const retitled: DraftSectionBlock = { ...target.block, title: operation.title };
        return commit(replaceAt(draft, containerPath, index, retitled), [], snapshot);
    }

    if ("title" in operation) {
        return err({ reason: "payload-kind-mismatch", detail: `the block ${operation.targetId} is an atom, and it takes a full block, not a title` });
    }
    const payload = operation.block;
    if (payload === null || typeof payload !== "object") {
        return err({ reason: "malformed-block", detail: "the payload is not an object" });
    }
    // The stamp sets the target id on the payload before the parse. Thus an id mismatch is
    // unrepresentable, and a replacement always keeps the id of its target.
    const stamped = { ...(payload as Record<string, unknown>), id: operation.targetId };
    const parsed = DraftBlockSchema.safeParse(stamped);
    if (!parsed.success) {
        return err(malformed(parsed.error));
    }
    if (parsed.data.kind === "section") {
        return err({ reason: "payload-kind-mismatch", detail: `the block ${operation.targetId} is an atom, and it cannot take a section payload` });
    }
    return commit(replaceAt(draft, containerPath, index, parsed.data), collectReferences(parsed.data), snapshot);
}

/**
 * Remove one block by its id.
 *
 * A removed section takes its whole subtree. A removed id is free for a later add.
 */
export function removeBlock(draft: DraftDocument, operation: RemoveOperation, snapshot: ReportSnapshot): Result<DraftDocument, DraftRefusal> {
    const target = locate(draft, operation.targetId);
    if (target === undefined) {
        return err({ reason: "unknown-target", detail: `no block holds the id ${operation.targetId}` });
    }
    const containerPath = target.path.slice(0, -1);
    const index = target.path[target.path.length - 1];
    return commit(removeAt(draft, containerPath, index), [], snapshot);
}

/**
 * Move one block to a destination.
 *
 * The moved block keeps its subtree. A section must not move into its own subtree, thus a move into the
 * subtree refuses with a cycle. A move with the moved block as its own anchor refuses.
 */
export function moveBlock(draft: DraftDocument, operation: MoveOperation, snapshot: ReportSnapshot): Result<DraftDocument, DraftRefusal> {
    const target = locate(draft, operation.targetId);
    if (target === undefined) {
        return err({ reason: "unknown-target", detail: `no block holds the id ${operation.targetId}` });
    }
    const movedBlock = target.block;
    const movedPath = target.path;

    const place = operation.destination?.place;
    if (place !== undefined && typeof place === "object") {
        const anchorId = "before" in place ? place.before : place.after;
        if (anchorId === operation.targetId) {
            return err({ reason: "unknown-target", detail: `the block ${operation.targetId} cannot anchor its own move` });
        }
    }

    return resolveDestination(draft, operation.destination).andThen((destination): Result<DraftDocument, DraftRefusal> => {
        if (destination.parentIsRoot && movedBlock.kind !== "section") {
            return err({ reason: "atom-at-root", detail: `a ${movedBlock.kind} block cannot sit at the root` });
        }
        // The moved block spans each path that starts with its own path. A destination inside that span is
        // a move into the block's own subtree, thus it is a cycle.
        if (movedBlock.kind === "section" && isPrefix(movedPath, destination.containerPath)) {
            return err({ reason: "cycle", detail: `the section ${operation.targetId} cannot move into its own subtree` });
        }
        const afterRemove = removeAt(draft, movedPath.slice(0, -1), movedPath[movedPath.length - 1]);
        // The removal shifts the sibling indices of the old parent. Thus the destination resolves again
        // against the reduced tree, and the fresh path and index address the correct place.
        return resolveDestination(afterRemove, operation.destination).andThen((landing): Result<DraftDocument, DraftRefusal> => {
            const candidate = insertAt(afterRemove, landing.containerPath, landing.index, movedBlock);
            return commit(candidate, [], snapshot);
        });
    });
}

/** One block, and the path of child indices from the root to the block. */
interface Located {
    block: DraftBlock;
    path: number[];
}

/** A resolved destination: the container path, the insert index, and whether the container is the root. */
interface ResolvedDestination {
    containerPath: number[];
    index: number;
    parentIsRoot: boolean;
}

/**
 * Resolve a destination to a container path and an insert index.
 *
 * An anchor place implies its parent. A named parent that does not hold the anchor refuses. A named
 * parent that is not a section refuses.
 */
function resolveDestination(document: DraftDocument, destination: DraftDestination | undefined): Result<ResolvedDestination, DraftRefusal> {
    const place: DraftPlace = destination?.place ?? "end";
    const parentId = destination?.parentId;

    if (typeof place === "object") {
        const anchorId = "before" in place ? place.before : place.after;
        const anchor = locate(document, anchorId);
        if (anchor === undefined) {
            return err({ reason: "unknown-target", detail: `no block holds the anchor id ${anchorId}` });
        }
        const containerPath = anchor.path.slice(0, -1);
        const anchorIndex = anchor.path[anchor.path.length - 1];
        const parentIsRoot = containerPath.length === 0;
        if (parentId !== undefined && idAtPath(document, containerPath) !== parentId) {
            return err({ reason: "unknown-target", detail: `the parent ${parentId} does not hold the anchor ${anchorId}` });
        }
        const index = "before" in place ? anchorIndex : anchorIndex + 1;
        return ok({ containerPath, index, parentIsRoot });
    }

    if (parentId === undefined) {
        const index = place === "start" ? 0 : document.sections.length;
        return ok({ containerPath: [], index, parentIsRoot: true });
    }

    const parent = locate(document, parentId);
    if (parent === undefined) {
        return err({ reason: "unknown-target", detail: `no block holds the parent id ${parentId}` });
    }
    if (parent.block.kind !== "section") {
        return err({ reason: "not-a-section", detail: `the block ${parentId} is a ${parent.block.kind}, not a section` });
    }
    const index = place === "start" ? 0 : parent.block.blocks.length;
    return ok({ containerPath: parent.path, index, parentIsRoot: false });
}

/**
 * Run the shared checks over a candidate, and give the candidate or a refusal.
 *
 * The id scan runs over the whole candidate, thus a duplicate anywhere refuses. The reference check runs
 * over the new references only, because each earlier reference passed on its own landing.
 */
function commit(candidate: DraftDocument, references: Reference[], snapshot: ReportSnapshot): Result<DraftDocument, DraftRefusal> {
    const duplicate = firstDuplicateId(candidate);
    if (duplicate !== undefined) {
        return err({ reason: "duplicate-id", detail: `the id ${duplicate} occurs more than one time in the draft` });
    }
    const unresolved: UnresolvedReference[] = [];
    for (const reference of references) {
        validateReferenceStructure(reference, snapshot).match(
            () => {},
            (failure) => {
                unresolved.push(failure);
            },
        );
    }
    if (unresolved.length > 0) {
        return err({ reason: "unresolved-reference", detail: `${unresolved.length} references do not resolve against the snapshot`, unresolved });
    }
    return ok(candidate);
}

/** Find a block by its id, with the path from the root. The search visits each block one time. */
function locate(document: DraftDocument, id: string): Located | undefined {
    return locateInBlocks(document.sections, id, []);
}

function locateInBlocks(blocks: DraftBlock[], id: string, prefix: number[]): Located | undefined {
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const path = [...prefix, index];
        if (block.id === id) {
            return { block, path };
        }
        if (block.kind === "section") {
            const found = locateInBlocks(block.blocks, id, path);
            if (found !== undefined) {
                return found;
            }
        }
    }
    return undefined;
}

/** Give the id of the block at a path, or `undefined` for the root. */
function idAtPath(document: DraftDocument, path: number[]): string | undefined {
    if (path.length === 0) {
        return undefined;
    }
    let blocks: DraftBlock[] = document.sections;
    let block: DraftBlock | undefined;
    for (const index of path) {
        block = blocks[index];
        if (block !== undefined && block.kind === "section") {
            blocks = block.blocks;
        }
    }
    return block?.id;
}

/** Give the children array at a container path. The root path gives the sections of the document. */
function getChildren(document: DraftDocument, containerPath: number[]): DraftBlock[] {
    let blocks: DraftBlock[] = document.sections;
    for (const index of containerPath) {
        const node = blocks[index];
        if (node.kind !== "section") {
            // A container path names a section at each step, thus this branch never runs.
            return [];
        }
        blocks = node.blocks;
    }
    return blocks;
}

/** Rebuild the document with new children at a container path, and share each untouched branch. */
function setChildren(document: DraftDocument, containerPath: number[], children: DraftBlock[]): DraftDocument {
    if (containerPath.length === 0) {
        // The root holds sections only. Each operation enforces that rule before it builds a candidate.
        return { ...document, sections: children as DraftSectionBlock[] };
    }
    return { ...document, sections: setChildrenInBlocks(document.sections, containerPath, children) as DraftSectionBlock[] };
}

function setChildrenInBlocks(blocks: DraftBlock[], containerPath: number[], children: DraftBlock[]): DraftBlock[] {
    const head = containerPath[0];
    const rest = containerPath.slice(1);
    const target = blocks[head];
    if (target.kind !== "section") {
        // A container path names a section at each step, thus this branch never runs.
        return blocks;
    }
    const updated: DraftSectionBlock =
        rest.length === 0 ? { ...target, blocks: children } : { ...target, blocks: setChildrenInBlocks(target.blocks, rest, children) };
    const copy = blocks.slice();
    copy[head] = updated;
    return copy;
}

/** Insert a block at an index inside a container. */
function insertAt(document: DraftDocument, containerPath: number[], index: number, block: DraftBlock): DraftDocument {
    const children = getChildren(document, containerPath);
    return setChildren(document, containerPath, [...children.slice(0, index), block, ...children.slice(index)]);
}

/** Remove the block at an index inside a container. */
function removeAt(document: DraftDocument, containerPath: number[], index: number): DraftDocument {
    const children = getChildren(document, containerPath);
    return setChildren(document, containerPath, [...children.slice(0, index), ...children.slice(index + 1)]);
}

/** Replace the block at an index inside a container. */
function replaceAt(document: DraftDocument, containerPath: number[], index: number, block: DraftBlock): DraftDocument {
    const children = getChildren(document, containerPath);
    const next = children.slice();
    next[index] = block;
    return setChildren(document, containerPath, next);
}

/** Give the first id that the candidate holds two times, or `undefined` when each id is unique. */
function firstDuplicateId(document: DraftDocument): string | undefined {
    const ids: string[] = [];
    collectIds(document.sections, ids);
    const seen = new Set<string>();
    for (const id of ids) {
        if (seen.has(id)) {
            return id;
        }
        seen.add(id);
    }
    return undefined;
}

function collectIds(blocks: DraftBlock[], into: string[]): void {
    for (const block of blocks) {
        into.push(block.id);
        if (block.kind === "section") {
            collectIds(block.blocks, into);
        }
    }
}

/**
 * Collect each reference that a block carries, and each reference of its descendants.
 *
 * The walk mirrors the block grammar: a claim carries its bindings, a metric carries its value, and a
 * chart, a table, a figure, and a citation carry one binding each. The chart encoding-column match is a
 * value-tier concern, thus this walk does not do it.
 */
function collectReferences(block: DraftBlock): Reference[] {
    const references: Reference[] = [];
    collectReferencesInto(block, references);
    return references;
}

function collectReferencesInto(block: DraftBlock, into: Reference[]): void {
    switch (block.kind) {
        case "section":
            for (const child of block.blocks) {
                collectReferencesInto(child, into);
            }
            return;
        case "claim":
            for (const binding of block.bindings) {
                into.push(binding);
            }
            return;
        case "metric":
            into.push(block.value);
            return;
        case "chart":
        case "table":
        case "figure":
        case "citation":
            into.push(block.binding);
            return;
        case "text":
            return;
    }
}

/** Give `true` when `prefix` is a prefix of `path`, or equal to it. */
function isPrefix(prefix: number[], path: number[]): boolean {
    if (prefix.length > path.length) {
        return false;
    }
    for (let index = 0; index < prefix.length; index++) {
        if (prefix[index] !== path[index]) {
            return false;
        }
    }
    return true;
}

/** Reduce a parse failure to a `malformed-block` refusal that names the first fault. */
function malformed(error: z.ZodError): DraftRefusal {
    const issue = error.issues[0];
    const location = issue.path.map((segment) => String(segment)).join(".");
    const detail = location.length > 0 ? `${location}: ${issue.message}` : issue.message;
    return { reason: "malformed-block", detail };
}
