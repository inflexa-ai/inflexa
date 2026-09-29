/**
 * The rules of the run-event read side that need no database and no durability
 * engine: narrowing a raw durable stream value to the chat data-part contract,
 * and the latest-wins reconciling fold, as a batch for `createRunEventStream`
 * and live for an embedder that reads the run streams itself.
 *
 * They live apart from the reader, thus a test drives them directly instead of
 * through a subscription.
 */

import { reconcileKey } from "../contracts/chat-frame.js";
import type { ChatPart } from "../contracts/chat-parts.js";
import { PART_REGISTRY } from "../contracts/part-registry.js";

/**
 * Narrow one raw stream value to a chat data part, or `null` when it is not one.
 *
 * A run's streams carry more than the contract: a sandbox step also writes its
 * loop orchestration under envelopes (`data-loop-event`, `data-sandbox-event`)
 * that belong to the workflow layer and have no registry entry. The seam's
 * contract is the `ChatPart` union, so anything the registry does not
 * classify is not deliverable — which also covers a part written by a producer
 * newer than the reader.
 *
 * The registry is keyed by the discriminant alone, so this validates `type` and
 * trusts the producer for the payload. There is no per-part schema to validate
 * against: `contracts/chat-parts.ts` declares interfaces, not Zod objects. Both
 * ends of this stream are typed against that same union inside this package, so
 * the discriminant is the boundary that can actually drift (a producer emitting
 * something else entirely) and the one worth checking.
 */
export function parseRunEventPart(value: unknown): ChatPart | null {
    if (typeof value !== "object" || value === null) return null;
    const type = (value as { type?: unknown }).type;
    if (typeof type !== "string") return null;
    if (!Object.hasOwn(PART_REGISTRY, type)) return null;
    return value as ChatPart;
}

/**
 * Collapse a batch of parts so each reconciling id appears once, carrying its
 * latest value, and every other part survives untouched in write order.
 *
 * `reconciling` in `PART_REGISTRY` already means "a later emission under this id
 * supersedes the earlier one" — `data-step-activity` mints a stable id per
 * `(runId, stepId)` precisely so a fold collapses every phase transition. Reading
 * the flag rather than holding a list of part types here keeps one source of
 * truth: a part type added to the registry later folds correctly without this
 * module changing.
 *
 * A survivor keeps the position of its LAST occurrence, so relative order among
 * the parts that are delivered is the order they were written.
 */
export function foldRunEventParts(parts: readonly ChatPart[]): ChatPart[] {
    const lastIndexByKey = new Map<string, number>();
    for (const [index, part] of parts.entries()) {
        const key = reconcileKey(part);
        if (key !== undefined) lastIndexByKey.set(key, index);
    }

    const folded: ChatPart[] = [];
    for (const [index, part] of parts.entries()) {
        const key = reconcileKey(part);
        if (key !== undefined && lastIndexByKey.get(key) !== index) continue;
        folded.push(part);
    }
    return folded;
}

/**
 * The live form of {@link foldRunEventParts}, for a stream that stays open. An
 * entry with a reconcile key waits `flushMs`, and a later entry with the same
 * key replaces it. Thus a catch-up burst delivers each key once, and a live
 * update lands one window later. Every other entry, also one of a type that the
 * registry does not know, goes to `emit` at once, thus it can overtake a held
 * entry. The held entries go to `emit` when the stream ends.
 */
export async function pipeFoldedRunEvents<T>(
    entries: AsyncIterable<T>,
    emit: (entry: T) => Promise<void>,
    flushMs: number,
): Promise<void> {
    const latestByKey = new Map<string, T>();
    const pendingKeys = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushChain: Promise<void> = Promise.resolve();

    const flushPending = async (): Promise<void> => {
        flushTimer = null;
        const keys = [...pendingKeys];
        pendingKeys.clear();
        for (const key of keys) {
            const entry = latestByKey.get(key);
            if (entry !== undefined) await emit(entry);
        }
    };

    const scheduleFlush = (): void => {
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
            // A timed flush has no caller to report to. A lasting emit failure
            // still reaches the caller, through the next direct emit or the
            // final flush.
            flushChain = flushChain.then(flushPending).catch(() => undefined);
        }, flushMs);
    };

    try {
        for await (const entry of entries) {
            const part = parseRunEventPart(entry);
            const key = part === null ? undefined : reconcileKey(part);
            if (key === undefined) {
                await emit(entry);
                continue;
            }
            latestByKey.set(key, entry);
            pendingKeys.add(key);
            scheduleFlush();
        }
    } finally {
        if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        await flushChain;
        if (pendingKeys.size > 0) await flushPending();
    }
}
