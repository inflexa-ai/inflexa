import { createSignal } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";

import { useBindings, MODE_BASE, KEYS, type BoundBinding, type LayerConfig } from "../keymap.ts";
import { seedTextareaText } from "../components/text_area.tsx";
import * as conversation from "./conversation.ts";

// Shell-style prompt-history recall for the chat composer: the whole vertical — its key layer, the recall
// position it walks, and the affordance the composer advertises it with — so `app.tsx` composes it in one
// call instead of owning any of it. The layer factory stays exported beside the hook because the dispatch
// test drives the SAME config the hook installs, over injected seams, rather than a replica that could drift.

/**
 * A live recall position: which entry the user is on, and the exact text that was seeded from it.
 *
 * The two travel together in one value because they must never disagree — an index/text pair updated
 * separately could address one entry while holding another's text, which is precisely the confusion the
 * stored-index rule exists to prevent. `index` is what steps (the entry list has non-unique texts, so only
 * a position can walk it correctly); `text` is what the liveness gate compares the buffer against, in O(1),
 * without needing the entry list in hand.
 */
export type RecallPosition = { readonly index: number; readonly text: string };

/** The seams the {@link historyRecallLayer} factory closes over — the composer it reads and seeds, the entry list, the recall position, and the retract gate it negates. */
export type HistoryRecallLayerDeps = {
    /**
     * The chat composer this layer is focus-`target`-gated to. Doubles as the buffer whose contents decide
     * whether a recall is still in progress and as the target each recalled entry is seeded into.
     */
    readonly target: TextareaRenderable | null;
    /**
     * The session's sent prompts, newest first. Real: {@link conversation.promptHistory}. Called ONLY from a
     * binding's `run` — never while merely building the config — so the transcript walk costs a keystroke
     * that actually steps history, not every keystroke in the app. See {@link HistoryRecallLayerDeps.hasEntries}.
     */
    readonly entries: () => string[];
    /**
     * Whether there is any prompt to recall — the cheap config-time counterpart to `entries`, asked on every
     * keystroke so `up` can be left unbound (and thus fall through to the editor) when history is empty.
     * Real: {@link conversation.hasPromptHistory}.
     */
    readonly hasEntries: () => boolean;
    /** Where the recall sits: `null` when not in recall, else the addressed index WITH the text it seeded. */
    readonly position: () => RecallPosition | null;
    /** Move the recall position (`null` leaves recall). */
    readonly setPosition: (position: RecallPosition | null) => void;
    /** The retract seam — recall is live exactly when a retract is NOT on offer. */
    readonly conversation: Pick<typeof conversation, "canRetract">;
};

/**
 * The shell-style prompt-history recall layer: `up` walks back through the prompts already sent in this
 * session, `down` walks forward, and `down` past the newest restores the empty composer. A pure factory
 * over its deps for the same no-drift reason as the retract layers — {@link usePromptRecall} registers it
 * with `useBindings`, re-invoked each keystroke so the gate below re-reads the live buffer, entry list, and
 * retract window. Composer-only: the pane's `up`/`down` stay scroll keys.
 *
 * **The gate is the negation of the retract's**, not a priority ordering. `up` has two claimants on this
 * one focus target, and `!canRetract()` makes them mutually exclusive *by construction* — they cannot both
 * be active whatever order the layers were registered in, which priority alone would not guarantee. It also
 * reads as the intent: recall is what the composer's `up` means whenever a retract is not on offer,
 * including mid-turn once the first output has closed the retract window.
 *
 * **Recall survives its own seed.** Entering from an empty buffer is only the first press; the seed then
 * makes the buffer non-empty, so an emptiness-only gate would hand the very next `up` to cursor movement
 * and strand the user one entry deep. The layer therefore also stays live while the buffer still EQUALS the
 * entry it seeded, and goes inert the moment it differs — the user has edited the recalled text and wants
 * their cursor keys back. That condition is DERIVED from the live buffer on each keystroke, never tracked
 * through an edit subscription or an `inRecall` flag: a flag would have to be cleared correctly on submit,
 * on clear-input, on session switch, and on a retract seeding the composer, and each of those is a place to
 * forget. Being a function of the buffer, this is right in all of them for free.
 *
 * **A stale position is harmless rather than reset.** Entry from an empty buffer always resumes at the
 * newest entry, discarding whatever an abandoned recall left behind — which is what lets the layer carry no
 * lifecycle wiring at all. The position's `index` is read ONLY once its `text` has confirmed the buffer
 * still matches it. Nothing clears a position when a recall is abandoned, so anything this layer does per
 * keystroke must stay cheap for a position that outlives its recall — which is why the liveness check
 * compares against the position's own text rather than looking the index up in the entry list.
 *
 * **A recalled prompt stays navigable.** The composer is multi-line, and recalled prompts often are too, so
 * recall must not hold both arrows hostage for as long as the entry sits in the buffer — that would leave
 * every line but the last unreachable. The chords therefore step history only from the EDGE of the buffer
 * the step moves away from: `up` recalls from the first row, `down` from the last, and anywhere in between
 * both fall through to the textarea's own caret movement (the shell/readline rule). A single-line entry is
 * both rows at once, so it recalls in either direction with no extra keystroke.
 *
 * The position is a STORED index, never a search of `entries()` for the buffer's text. `promptHistory`
 * collapses only ADJACENT duplicates, so identical prompts separated by another remain distinct entries;
 * a search would resolve every occurrence to the newest and silently skip everything between them.
 */
export function historyRecallLayer(deps: HistoryRecallLayerDeps): LayerConfig {
    const target = deps.target;
    const buffer = target?.plainText ?? null;
    const position = deps.position();
    // In recall exactly while the buffer still holds the text the position seeded — an O(1) comparison
    // against the position's OWN text, deliberately not a lookup into `entries()`. `activeLayers` re-invokes
    // every layer's thunk on every keystroke BEFORE it filters on `enabled`, so anything read here is read
    // on each key typed anywhere in the app, dialogs included. Reading the entry list here would therefore
    // walk the whole mounted transcript per keystroke for as long as a position happened to be set — and a
    // position outlives its recall (nothing clears it on an edit, a submit, a clear-input, or a session
    // swap; it is simply overwritten on the next entry). Carrying the text in the position removes the need
    // for the list at all, so the walk now costs only a press that actually steps history.
    const inRecall = position !== null && buffer !== null && buffer === position.text;

    // Which buffer edge the caret sits on, deciding whether a chord steps history or moves the caret. Read
    // from the edit buffer rather than the plain text so a soft-wrapped long line still counts as one row —
    // wrapping is presentation, and a chord that behaved differently at one terminal width than another
    // would be indefensible.
    const caret = target?.editBuffer.getCursorPosition();
    const onFirstRow = caret === undefined || caret.row === 0;
    const onLastRow = caret === undefined || !target || caret.row === target.editBuffer.getLineCount() - 1;

    // Press-time only: this is where the entry list is finally built. `to` is resolved against the freshly
    // read list so a clamp always reflects the history as it stands at the press, not as it stood when the
    // config was assembled.
    function step(resolve: (entries: string[]) => number): void {
        if (!target) return;
        const entries = deps.entries();
        const to = resolve(entries);
        const text = entries[to];
        if (text === undefined) return;
        // A clamped step that resolves back to the entry already showing is a HOLD, and a hold must touch
        // NOTHING — not the buffer, and not the caret. Re-seeding identical text looks free but ends in a
        // caret move to the end, which on a multi-line entry yanks it from wherever the user put it. That is
        // worst exactly where it is most reachable: the edge rule sends a user to row 0 of the oldest entry
        // to correct its first line, and one more `up` there — out of habit, or not knowing it is the oldest
        // — would undo the positioning the rule exists to allow. readline holds both at history-top; so does
        // this. Gated on `inRecall` so a STALE position (one abandoned by an edit, kept deliberately — see
        // above) can never suppress a fresh entry that happens to address the same place.
        if (inRecall && position !== null && to === position.index && text === position.text) return;
        deps.setPosition({ index: to, text });
        seedTextareaText(target, text);
    }

    // The binding LIST is rebuilt per keystroke along with the rest of the config, so each chord is bound
    // only when there is something for it to do — the engine `preventDefault`s whatever it matches, and a
    // key swallowed to run a no-op is a key stolen from the editor underneath. `enabled` alone cannot make
    // that distinction: the layer is live on an empty buffer so `up` can ENTER recall, which is exactly the
    // state where `down` has nowhere to go; and it is live across a whole recalled entry, most rows of which
    // must still take the caret.
    const bindings: BoundBinding[] = [];

    // Older. From an empty buffer that is the newest entry (index 0); already in recall, one further back,
    // clamped so the oldest entry HOLDS rather than falling off the end. Unbound when the caret has rows
    // above it to reach, or when there is no history at all — an empty history leaves `up` to the editor
    // rather than eating it. `hasEntries` answers that last question without building the list.
    if (onFirstRow && (inRecall || (buffer === "" && deps.hasEntries()))) {
        const at = inRecall ? position.index : null;
        bindings.push({
            chord: KEYS.up,
            run: () => step((entries) => (at === null ? 0 : Math.min(at + 1, entries.length - 1))),
            desc: "Recall previous prompt",
            group: "Chat",
        });
    }

    // Newer, and past the newest back to the empty composer the recall was entered from. Bound only while a
    // recall is in progress with the caret on the last row, so outside one — and on any earlier row — `down`
    // stays ordinary caret movement. The `position`/`target` re-checks are for narrowing: `inRecall` already
    // implies both, but only through a chain tsc does not follow. Leaving recall needs no entry list.
    if (inRecall && onLastRow && position !== null && target) {
        const at = position.index;
        bindings.push({
            chord: KEYS.down,
            run: () => {
                if (at === 0) {
                    deps.setPosition(null);
                    seedTextareaText(target, "");
                    return;
                }
                step(() => at - 1);
            },
            desc: "Recall next prompt",
            group: "Chat",
        });
    }

    return {
        mode: MODE_BASE,
        target,
        enabled: !deps.conversation.canRetract() && (buffer === "" || inRecall),
        bindings,
    };
}

/** What {@link usePromptRecall} hands back to its host. */
export type PromptRecall = {
    /**
     * Whether the recall chord would actually bring something back right now. The composer shows it in the
     * empty-buffer placeholder, the one spot where advertising it is honest. Both reads are reactive, so the
     * affordance appears with the first sent prompt and steps aside for the retract's claim on the chord.
     */
    readonly canRecall: () => boolean;
};

/**
 * Install prompt-history recall on the chat composer for the lifetime of the calling component, and hand
 * back the affordance state its host renders. Owns the recall position, so the host holds no state for it:
 * the position needs no reset wiring, because entering recall from an empty buffer always resumes at the
 * newest entry and discards whatever an abandoned recall left behind.
 *
 * `composer` is a GETTER, not a value: the host's textarea ref is assigned by a ref callback after this runs,
 * and the layer must re-read it (along with its live buffer) on every keystroke.
 */
export function usePromptRecall(composer: () => TextareaRenderable | null): PromptRecall {
    const [position, setPosition] = createSignal<RecallPosition | null>(null);

    useBindings(() =>
        historyRecallLayer({
            target: composer(),
            entries: conversation.promptHistory,
            hasEntries: conversation.hasPromptHistory,
            position,
            setPosition,
            conversation,
        }),
    );

    return { canRecall: () => !conversation.canRetract() && conversation.hasPromptHistory() };
}
