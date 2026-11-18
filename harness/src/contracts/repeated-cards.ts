// The cards of one message that repeat an earlier card. Browser-safe: each import from outside `contracts/` is a type import.

import type { FileReferencePart, KnownChatPart } from "./chat-parts.js";
import { isKnownPartType } from "./part-registry.js";

// The guard narrows by the registry key alone, the same as `isKnownPartFrame`: `checkChatPart` checks the payload of a
// known part where the part arrives, thus a part with a known key in a message carries the checked shape.
function isKnownPart(part: { readonly type: string }): part is KnownChatPart {
    return isKnownPartType(part.type);
}

/**
 * The indexes of the plan cards that repeat a card earlier in the same message. The first card stays.
 *
 * `generate_plan` shows the card of the plan that it makes, and a `show_plan` of the same plan gives a card with the
 * same id. A plan part does not reconcile, thus both cards land in the message. A later message can show the plan
 * again on purpose, thus the check stays inside one message.
 */
export function repeatedPlanIndexes(parts: readonly { readonly type: string }[]): ReadonlySet<number> {
    const seen = new Set<string>();
    const repeated = new Set<number>();
    for (const [index, part] of parts.entries()) {
        if (!isKnownPart(part) || part.type !== "data-plan") continue;
        if (seen.has(part.id)) repeated.add(index);
        else seen.add(part.id);
    }
    return repeated;
}

/**
 * The file cards of a message that lose a file to a later card, by index, with the files that stay. A card that keeps
 * no file maps to null. A card that keeps each of its files is not in the map.
 *
 * `run_script` shows each file that it writes in a card with the script, and the agent can show the same file again
 * with `show_file` beside its text. The latest card keeps the file. A later message can show the file again on purpose,
 * thus the check stays inside one message.
 */
export function supersededFileReferences(parts: readonly { readonly type: string }[]): ReadonlyMap<number, FileReferencePart | null> {
    const later = new Set<string>();
    const superseded = new Map<number, FileReferencePart | null>();
    for (let index = parts.length - 1; index >= 0; index--) {
        const part = parts[index];
        if (part === undefined || !isKnownPart(part) || part.type !== "data-file-reference") continue;
        const files = part.files.filter((file) => !later.has(file.path));
        for (const file of part.files) later.add(file.path);
        if (files.length === part.files.length) continue;
        superseded.set(index, files.length === 0 ? null : { ...part, files });
    }
    return superseded;
}
