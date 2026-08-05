import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { InputRenderable } from "@opentui/core";

import { GLYPHS, space } from "../../../lib/design_system.ts";
import { KEYS, chordLabel, type Chord } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel, useDialogCloseGuard, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { TextInput } from "../text_input.tsx";
import { FixedList } from "../fixed_list.tsx";
import type { SelectItem, SelectMode } from "../list_core.tsx";

/** NORMAL-mode re-entry to the filter: one source for the binding and its footer label. */
const FILTER_KEY: Chord = { key: "i" };

/** Props for {@link SelectDialog}. */
export type SelectDialogProps<T> = {
    title: string;
    /** Filter placeholder; defaults to a generic "Type to filter…". */
    placeholder?: string;
    /** The pickable rows — fixed for the dialog's lifetime (it composes {@link FixedList}). */
    items: readonly SelectItem<T>[];
    /** Muted line when nothing matches the filter. */
    emptyText: string;
    /** Selection mode, default `"single"`. */
    mode?: SelectMode;
    /** Multi mode: values pre-selected on open. */
    initialSelected?: ReadonlySet<T>;
    /** Row the cursor opens on (matched by `===` against row values); absent/unmatched opens on row 0. */
    initialValue?: T;
    /**
     * The highlighted row changed — including the filter-driven jump to the best match, and
     * `undefined` once the query matches nothing. Forwarded verbatim to the list; the dialog itself
     * stays domain-agnostic, so what a host does with the row (the theme picker previews it live) is
     * entirely the host's business.
     */
    onCursorChange?: (value: T | undefined) => void;
    /** Single mode: a row was picked (enter). The caller closes the dialog. */
    onSelect?: (value: T) => void;
    /** Multi mode: the batch was confirmed (enter). The caller closes the dialog. */
    onConfirm?: (values: T[]) => void;
    /**
     * One extra footer segment, for a key the HOST binds rather than the dialog (the analysis switcher's
     * copy-id chord). The dialog owns its footer and stays domain-agnostic, so a host binding would
     * otherwise be reachable but unadvertised — discoverable only through the WhichKey overlay, which a
     * user has to already suspect something is there to open.
     */
    footerHint?: string;
    /** Wired to every non-commit close (esc, click-outside, ctrl+c) via the dialog funnel. */
    onCancel: () => void;
};

/**
 * The reusable picker dialog: DialogPanel + filter `TextInput` + {@link FixedList} — the dialog
 * form of the list primitives, serving every "choose one of these" command. The dialog owns the
 * input and hands its value down as the list's `query`; the list owns cursor, selection, and
 * submit.
 *
 * Multi mode runs the app's INSERT/NORMAL split, because space must type into a focused filter
 * yet toggle rows otherwise (the bare-printable-key rule). It MOUNTS IN NORMAL, as FilePicker
 * does: `i` enters the filter, esc while focused BLURS back (a close-guard veto — dialogs never
 * bind esc themselves), and esc in NORMAL cancels. The footer leads with the mode word, because
 * the same keystroke does different things in each state and nothing else on screen says which.
 *
 * Single mode has no split and mounts focused — enter and arrows don't collide with typing, and
 * its only verb is "find one, press enter".
 */
export function SelectDialog<T>(props: SelectDialogProps<T>): JSX.Element {
    const dialog = useDialogEntry();
    const [query, setQuery] = createSignal("");
    const [inputFocused, setInputFocused] = createSignal(false);
    const [selCount, setSelCount] = createSignal(props.initialSelected?.size ?? 0);
    let inputRef: InputRenderable | null = null;

    const mode = (): SelectMode => props.mode ?? "single";

    useDialogCancel(() => props.onCancel());
    // The INSERT→NORMAL transition: veto the esc-cancel while the filter holds focus and blur it
    // instead. Only multi mode needs a NORMAL state; single-mode esc cancels on first press.
    useDialogCloseGuard((reason) => {
        if (reason === "cancel" && mode() === "multi" && inputFocused()) {
            inputRef?.blur();
            return false;
        }
        return true;
    });
    // NORMAL-mode re-entry to the filter. Bare printable is safe here: the layer is enabled only
    // while no editor is focused.
    useDialogBindings(() => ({
        enabled: mode() === "multi" && !inputFocused(),
        bindings: [{ chord: FILTER_KEY, run: () => inputRef?.focus(), desc: "Filter", group: "List" }],
    }));

    // The footer names only what is SPECIFIC to this surface. Cursor movement is app-wide vocabulary —
    // arrows, ctrl+p/n, page keys, and in NORMAL the vim set (j/k, gg, G) — carried by every navigable
    // surface and documented live by the WhichKey overlay. Spelling it here costs the row's width to
    // restate what the user already knows, and it reads as though THIS list navigates differently.
    //
    // The mode WORD does earn its place in multi mode: the same keystroke does different things in each
    // state, and nothing else on screen says which state is live.
    function footer(): string {
        const sep = ` ${GLYPHS.middot} `;
        const extra = props.footerHint ? [props.footerHint] : [];
        if (mode() === "single") {
            return [`${chordLabel(KEYS.enter)} select`, `${chordLabel(KEYS.escape)} cancel`, ...extra].join(sep);
        }
        const count = `${selCount()} selected`;
        return inputFocused()
            ? ["INSERT", `${chordLabel(KEYS.enter)} confirm`, `${chordLabel(KEYS.escape)} normal`, ...extra, count].join(sep)
            : [
                  "NORMAL",
                  `${chordLabel(KEYS.space)} toggle`,
                  `${chordLabel(KEYS.enter)} confirm`,
                  `${chordLabel(FILTER_KEY)} filter`,
                  `${chordLabel(KEYS.escape)} cancel`,
                  ...extra,
                  count,
              ].join(sep);
    }

    return (
        <DialogPanel title={props.title} size="lg" padY footer={footer()}>
            <TextInput
                chrome="bare"
                /* Single mode opens in INSERT — its only verb is "find one and press enter", so the filter
                   is where the hands belong. Multi mode opens in NORMAL, matching FilePicker: its verbs are
                   space and enter, and mounting focused means the very first space types a character
                   instead of selecting a row, with no visible cue that a mode even exists.
                   Showcased exhibits must not grab focus at mount either — see DialogEntryHandle.inert. */
                autoFocus={mode() === "single" && !(dialog?.inert ?? false)}
                placeholder={props.placeholder ?? `Type to filter${GLYPHS.ellipsis}`}
                onRef={(r: InputRenderable) => {
                    inputRef = r;
                    // Only claim the entry's initial focus when this dialog means to open focused: the host
                    // applies it on push AND on reveal, so registering it would re-focus a NORMAL-mode
                    // dialog every time a stacked dialog above it closes.
                    if (mode() === "single") dialog?.setInitialFocus(r);
                }}
                onFocusChange={setInputFocused}
                onInput={setQuery}
            />
            {/* Breathing room between the filter and the list. Safe as a transparent gap because it
                sits ABOVE the list's flexGrow scrollbox — the one-cell scrollbox bleed only spills
                onto the sibling BELOW it (there the list's own painted detail box reclaims the row). */}
            <box height={space.sm} flexShrink={0} />
            <FixedList
                items={props.items}
                query={query()}
                emptyText={props.emptyText}
                mode={props.mode}
                initialSelected={props.initialSelected}
                initialValue={props.initialValue}
                onSelect={props.onSelect}
                onConfirm={props.onConfirm}
                onCursorChange={props.onCursorChange}
                onSelectionChange={(s) => setSelCount(s.size)}
                bareKeysEnabled={!inputFocused()}
            />
        </DialogPanel>
    );
}
