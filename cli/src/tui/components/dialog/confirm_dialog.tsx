import { createSignal, For } from "solid-js";
import type { JSX } from "solid-js";

import { GLYPHS } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";

/** The user's choice: `true` = confirmed, `false` = cancelled, `undefined` = dismissed via esc. */
export type ConfirmResult = boolean | undefined;

/**
 * A binary confirm / cancel dialog. Left/right arrows toggle the active choice; enter commits it;
 * esc cancels via the host's structural binding. The active choice is rendered as a highlighted
 * pill (accent bg + onAccent text) so the user sees which action enter will take.
 *
 * The active choice defaults to "cancel" — an accidental enter must not confirm a destructive
 * action. Callers that want "confirm" as the default (a non-destructive yes/no) can override, but
 * the safe default errs toward not destroying user data.
 */
export function ConfirmDialog(props: {
    /** Panel title shown in the border chrome. */
    title: string;
    /** The body question / message, rendered in the muted foreground. */
    message: string;
    /** `danger` renders the destructive-confirm chrome (double border, error color). */
    tone?: "default" | "danger";
    /** Called when the user confirms (enter with "confirm" active). */
    onConfirm: () => void;
    /** Called when the user cancels: enter with "cancel" active, or any non-commit close (esc, click-outside). */
    onCancel: () => void;
    /** Override label for the cancel button (defaults to "cancel"). */
    cancelLabel?: string;
    /** The initially-active choice — defaults to "cancel" so enter doesn't confirm by accident. */
    defaultActive?: "confirm" | "cancel";
}): JSX.Element {
    const [active, setActive] = createSignal<"confirm" | "cancel">(props.defaultActive ?? "cancel");

    useDialogCancel(() => props.onCancel());

    function toggle(): void {
        setActive((a) => (a === "confirm" ? "cancel" : "confirm"));
    }

    function commit(): void {
        if (active() === "confirm") props.onConfirm();
        else props.onCancel();
    }

    useDialogBindings(() => ({
        bindings: [
            { chord: KEYS.enter, run: commit, desc: "Confirm selection", group: "Dialog" },
            { chord: KEYS.left, run: toggle, desc: "Switch option", group: "Dialog" },
            { chord: KEYS.right, run: toggle, desc: "Switch option", group: "Dialog" },
        ],
    }));

    const choices = () => ["cancel", "confirm"] as const;

    return (
        <DialogPanel
            title={props.title}
            size="md"
            tone={props.tone}
            padY
            footer={`${chordLabel(KEYS.left)}/${chordLabel(KEYS.right)} switch ${GLYPHS.middot} ${chordLabel(KEYS.enter)} confirm ${GLYPHS.middot} ${chordLabel(KEYS.escape)} cancel`}
        >
            <box paddingBottom={1}>
                <text fg={theme().fgMuted}>{props.message}</text>
            </box>
            <box flexDirection="row" justifyContent="flex-end" gap={1}>
                <For each={choices()}>
                    {(key) => {
                        const label = () => (key === "cancel" ? (props.cancelLabel ?? key) : key);
                        const isActive = () => active() === key;
                        return (
                            <box
                                paddingLeft={1}
                                paddingRight={1}
                                backgroundColor={isActive() ? theme().accent : undefined}
                                onMouseUp={() => {
                                    if (key === "confirm") props.onConfirm();
                                    else props.onCancel();
                                }}
                            >
                                <text fg={isActive() ? theme().onAccent : theme().fgMuted}>{label()}</text>
                            </box>
                        );
                    }}
                </For>
            </box>
        </DialogPanel>
    );
}
