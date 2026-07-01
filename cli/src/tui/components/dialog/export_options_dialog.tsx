import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";
import { onMount } from "solid-js";

import { GLYPHS } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { useBindings, KEYS, chordLabel } from "../../keymap.ts";
import { DialogPanel } from "./dialog_panel.tsx";
import { Bold } from "../emphasis.tsx";
import { TextArea } from "../text_area.tsx";

/** A togglable boolean option shown as a checkbox row. */
export type OptionItem = {
    /** Stable key returned in the result record. */
    key: string;
    /** Display label beside the checkbox. */
    label: string;
    /** Initial checked state. */
    defaultValue: boolean;
};

/** Configuration for the optional text field shown above the checkboxes. */
export type OptionTextField = {
    /** Label rendered above the textarea. */
    label: string;
    /** Initial textarea value. */
    defaultValue: string;
    /** Placeholder text when the field is empty. */
    placeholder: string;
};

/** The result handed to `onConfirm`: the text field value (when present) + every option's state. */
export type ExportOptionsResult = {
    /** The text field value, present only when the dialog was configured with a text field. */
    text?: string;
    /** Each option's key → its final boolean state. */
    options: Record<string, boolean>;
};

/**
 * A form dialog with an optional text field and a list of togglable checkbox options. Tab cycles
 * focus between the text field and each option; space toggles the focused option; enter confirms
 * the whole form. Ported from OpenCode's export-options dialog but genericized — callers supply
 * their own option items and text-field config.
 *
 * When `textField` is provided, the dialog opens with the textarea focused and tab moves to the
 * first option. When absent, the first option is focused initially.
 */
export function ExportOptionsDialog(props: {
    /** Panel title shown in the border chrome. */
    title: string;
    /** Optional single-line text field (e.g. a filename) shown above the checkboxes. */
    textField?: OptionTextField;
    /** The togglable options. */
    items: OptionItem[];
    /** Called with the final form state when the user confirms. */
    onConfirm: (result: ExportOptionsResult) => void;
    /** Called when the user cancels (esc). */
    onCancel: () => void;
}): JSX.Element {
    let textareaRef: TextareaRenderable | undefined;

    const allKeys = (): string[] => {
        const keys: string[] = [];
        if (props.textField) keys.push("__text__");
        for (const item of props.items) keys.push(item.key);
        return keys;
    };

    const [activeKey, setActiveKey] = createSignal(allKeys()[0] ?? "");
    /* eslint-disable solid/reactivity -- seed-once: component mounts once with fixed props; items are read once to build the initial checked-state map */
    const initValues: Record<string, boolean> = {};
    for (const item of props.items) initValues[item.key] = item.defaultValue;
    /* eslint-enable solid/reactivity */
    const [values, setValues] = createSignal<Record<string, boolean>>(initValues);

    function cycleNext(): void {
        const keys = allKeys();
        const idx = keys.indexOf(activeKey());
        setActiveKey(keys[(idx + 1) % keys.length]!);
    }

    function toggleCurrent(): void {
        const key = activeKey();
        if (key === "__text__") return;
        setValues((prev) => ({ ...prev, [key]: !prev[key] }));
    }

    function confirm(): void {
        const result: ExportOptionsResult = {
            options: values(),
        };
        if (props.textField && textareaRef) {
            result.text = textareaRef.plainText;
        }
        props.onConfirm(result);
    }

    // Tab cycles through all fields (text + options). Escape cancels.
    useBindings(() => ({
        bindings: [
            { chord: { key: "tab" }, run: cycleNext, desc: "Next option", group: "Dialog" },
            { chord: KEYS.escape, run: () => props.onCancel(), desc: "Cancel", group: "Dialog" },
        ],
    }));

    // Space toggles the active option (only when not on the text field).
    useBindings(() => ({
        enabled: activeKey() !== "__text__",
        bindings: [
            { chord: KEYS.space, run: toggleCurrent, desc: "Toggle option", group: "Dialog" },
            { chord: KEYS.enter, run: confirm, desc: "Confirm", group: "Dialog" },
        ],
    }));

    // When the text field is active, the form-level enter-to-confirm is in the keymap engine
    // as a fallback — TextArea's renderable-level submit fires first when the textarea is focused.
    useBindings(() => ({
        enabled: activeKey() === "__text__",
        bindings: [{ chord: KEYS.enter, run: confirm, desc: "Confirm", group: "Dialog" }],
    }));

    onMount(() => {
        if (textareaRef) {
            queueMicrotask(() => {
                if (!textareaRef || textareaRef.isDestroyed) return;
                textareaRef.focus();
                textareaRef.gotoLineEnd();
            });
        }
    });

    const isOnText = () => activeKey() === "__text__";
    const footer = () =>
        isOnText()
            ? `${chordLabel(KEYS.enter)} confirm ${GLYPHS.middot} tab options ${GLYPHS.middot} ${chordLabel(KEYS.escape)} cancel`
            : `${chordLabel(KEYS.space)} toggle ${GLYPHS.middot} tab next ${GLYPHS.middot} ${chordLabel(KEYS.enter)} confirm ${GLYPHS.middot} ${chordLabel(KEYS.escape)} cancel`;

    return (
        <DialogPanel title={props.title} size="md" padY footer={footer()}>
            <Show when={props.textField} keyed>
                {(field: OptionTextField) => (
                    <box gap={1} paddingBottom={1}>
                        <text fg={theme().fg}>
                            <Bold>{field.label}:</Bold>
                        </text>
                        <TextArea
                            chrome="bare"
                            height={3}
                            placeholder={field.placeholder}
                            initialValue={field.defaultValue}
                            onRef={(r: TextareaRenderable) => {
                                textareaRef = r;
                            }}
                            onSubmit={confirm}
                        />
                    </box>
                )}
            </Show>
            <box flexDirection="column">
                <For each={props.items}>
                    {(item) => {
                        const isActive = () => activeKey() === item.key;
                        const isChecked = () => values()[item.key] ?? false;
                        return (
                            <box
                                flexDirection="row"
                                gap={2}
                                paddingLeft={1}
                                backgroundColor={isActive() ? theme().bgActive : undefined}
                                onMouseUp={() => {
                                    setActiveKey(item.key);
                                    setValues((prev) => ({ ...prev, [item.key]: !prev[item.key] }));
                                }}
                            >
                                <text fg={isActive() ? theme().accent : theme().fgMuted}>{isChecked() ? GLYPHS.check : GLYPHS.circleHollow}</text>
                                <text fg={isActive() ? theme().accent : theme().fg}>{item.label}</text>
                            </box>
                        );
                    }}
                </For>
            </box>
        </DialogPanel>
    );
}
