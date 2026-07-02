import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { InputRenderable } from "@opentui/core";

import { GLYPHS } from "../../../lib/design_system.ts";
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
    /** Single mode: a row was picked (enter). The caller closes the dialog. */
    onSelect?: (value: T) => void;
    /** Multi mode: the batch was confirmed (enter). The caller closes the dialog. */
    onConfirm?: (values: T[]) => void;
    /** Wired to every non-commit close (esc, click-outside, ctrl+c) via the dialog funnel. */
    onCancel: () => void;
};

/**
 * The reusable picker dialog: DialogPanel + filter `TextInput` + {@link FixedList} — the dialog
 * form of the list primitives, serving every "choose one of these" command. The dialog owns the
 * input and hands its value down as the list's `query`; the list owns cursor, selection, and
 * submit.
 *
 * Multi mode runs a minimal INSERT/NORMAL split, because space must type into a focused filter
 * yet toggle rows otherwise (the bare-printable-key rule): esc while the input is focused BLURS
 * it (a close-guard veto — dialogs never bind esc themselves) unlocking space/`i`; esc again
 * cancels. Single mode has no such split — enter and arrows don't collide with typing.
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

    function footer(): string {
        const sep = ` ${GLYPHS.middot} `;
        const move = `${chordLabel(KEYS.up)}/${chordLabel(KEYS.down)} move`;
        if (mode() === "single") {
            return [move, `${chordLabel(KEYS.enter)} select`, `${chordLabel(KEYS.escape)} cancel`].join(sep);
        }
        const count = `${selCount()} selected`;
        return inputFocused()
            ? [move, `${chordLabel(KEYS.enter)} confirm`, `${chordLabel(KEYS.escape)} list keys`, count].join(sep)
            : [
                  `${chordLabel(KEYS.space)} toggle`,
                  `${chordLabel(KEYS.enter)} confirm`,
                  `${chordLabel(FILTER_KEY)} filter`,
                  `${chordLabel(KEYS.escape)} cancel`,
                  count,
              ].join(sep);
    }

    return (
        <DialogPanel title={props.title} size="lg" footer={footer()}>
            <TextInput
                chrome="bare"
                /* Showcased exhibits must not grab focus at mount — see DialogEntryHandle.inert. */
                autoFocus={!(dialog?.inert ?? false)}
                placeholder={props.placeholder ?? `Type to filter${GLYPHS.ellipsis}`}
                onRef={(r: InputRenderable) => {
                    inputRef = r;
                    dialog?.setInitialFocus(r);
                }}
                onFocusChange={setInputFocused}
                onInput={setQuery}
            />
            <FixedList
                items={props.items}
                query={query()}
                emptyText={props.emptyText}
                mode={props.mode}
                initialSelected={props.initialSelected}
                onSelect={props.onSelect}
                onConfirm={props.onConfirm}
                onSelectionChange={(s) => setSelCount(s.size)}
                bareKeysEnabled={!inputFocused()}
            />
        </DialogPanel>
    );
}
