import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { BoxRenderable } from "@opentui/core";

import { GLYPHS, size, space } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { chordLabel, useBindings, MODE_BASE, type Chord } from "../keymap.ts";
import { Bold, Fg } from "./emphasis.tsx";

/** The key that resumes paused work, or ends the wait of its timer. Bare: legal only on the focus-gated layer. */
const RESUME_KEY: Chord = { key: "r" };
/** The key that stops the paused work. */
const STOP_KEY: Chord = { key: "s" };
/** The key that holds work in `retrying`: its timer stops, and it waits for a resume. */
const HOLD_KEY: Chord = { key: "h" };

/** Props for {@link PausePrompt}. */
export type PausePromptProps = {
    /** `retrying`: the system sends the request again at the next retry. `paused`: only a resume ends the wait. */
    state: "retrying" | "paused";
    /** The cause of the pause in words, with the reason of the host for a refusal of the host. */
    cause: string;
    /** The remedy that the server gives for the cause, for example the command that signs in again. */
    remedy?: string;
    /** The next retry of a wait in `retrying`, for example `retry 2 at 10:32:05`. */
    nextRetry?: string;
    /** How many more workflows of the same work wait, for example a sub-agent beside the turn. 0 hides the hint. */
    othersWaiting: number;
    /** True while a resume or a stop is in flight: the action keys are inert, thus a second press cannot send it again. */
    busy?: boolean;
    /** True for a static gallery exhibit: the box is not focusable and a click on an action does nothing. */
    inert?: boolean;
    /** Resume the work. In `retrying`, the same call ends the wait of the timer at once ("retry now"). */
    onResume: () => void;
    /** Stop the work. */
    onStop: () => void;
    /** Hold work in `retrying`: its timer stops, and it waits for a resume. The prompt offers it in `retrying` only. */
    onHold: () => void;
    /** Receives the focusable box of the prompt on mount. The host focuses it, the same as the docked ask prompt. */
    onFocusReady?: (r: BoxRenderable) => void;
};

/**
 * The docked prompt of paused work: a turn that waits for a resume, or for the next retry of its timer. It takes the
 * form of the docked ask prompt (`ask_prompt.tsx`): a full-width, non-collapsing row painted with the raised panel
 * background, thus it can sit directly below the flexGrow scrollbox of the chat (the 1-cell scrollbox-bleed rule),
 * with the marker gutter beside the content column.
 *
 * It gives the state, the cause, the remedy when the server knows one, and the next retry of a wait in `retrying`.
 * Its two actions are bare `r` (resume, "retry now" in `retrying`) and `s` (stop), on ONE key layer that is gated on
 * the focus target of the prompt's own box. That gate is what makes bare printables legal: the box is never an
 * editor. Pure props and callbacks: the widget knows nothing about the server or the pause store.
 */
export function PausePrompt(props: PausePromptProps): JSX.Element {
    let boxRef: BoxRenderable | null = null;
    // A click answers on mouse-up, and a drag that ends on an action carries a live selection, which is not a click.
    const renderer = useRenderer();

    function resume(): void {
        if (props.busy) return;
        props.onResume();
    }

    function stop(): void {
        if (props.busy) return;
        props.onStop();
    }

    function hold(): void {
        if (props.busy || props.state !== "retrying") return;
        props.onHold();
    }

    function onActionClick(action: "resume" | "hold" | "stop"): void {
        if (props.inert) return;
        if (renderer.getSelection()?.getSelectedText()) return;
        if (action === "resume") resume();
        else if (action === "hold") hold();
        else stop();
    }

    const resumeLabel = (): string => (props.state === "retrying" ? "retry now" : "resume");
    const title = (): string => (props.state === "retrying" ? "The turn waits to retry" : "The turn is paused");

    useBindings(() => ({
        mode: MODE_BASE,
        target: boxRef,
        bindings: [
            { chord: RESUME_KEY, run: resume, desc: resumeLabel() === "resume" ? "Resume" : "Retry now", group: "Pause" },
            { chord: HOLD_KEY, run: hold, desc: "Hold", group: "Pause", enabled: props.state === "retrying" },
            { chord: STOP_KEY, run: stop, desc: "Stop", group: "Pause" },
        ],
    }));

    return (
        <box
            ref={(r: BoxRenderable) => {
                boxRef = r;
                // An inert exhibit stays non-focusable, thus a click on it never takes the focus of the gallery pane.
                r.focusable = !(props.inert ?? false);
                props.onFocusReady?.(r);
            }}
            width="100%"
            flexShrink={0}
            flexDirection="row"
            backgroundColor={theme().bgRaised}
            paddingLeft={space.sm}
            paddingRight={space.sm}
        >
            <box width={size.gutter} flexShrink={0}>
                <text>
                    <Fg role="warning">{GLYPHS.warning}</Fg>
                </text>
            </box>
            <box flexDirection="column" flexGrow={1}>
                <text>
                    <Fg role="fg">
                        <Bold>{title()}</Bold>
                    </Fg>
                </text>
                <text>
                    <Fg role="warning">{props.cause}</Fg>
                </text>
                <Show when={props.remedy}>
                    <text>
                        <Fg role="fg">{props.remedy}</Fg>
                    </text>
                </Show>
                <Show when={props.state === "retrying" ? props.nextRetry : undefined}>
                    <text>
                        <Fg role="fgMuted">{`next: ${props.nextRetry ?? ""}`}</Fg>
                    </text>
                </Show>
                {/* One mouse target for each action, as in the ask prompt: opentui attaches a mouse handler to a
                renderable, not to an inline span. The segments compose one hint line. */}
                <box flexDirection="row">
                    <text selectable={false} onMouseUp={() => onActionClick("resume")}>
                        <Fg role="accent">
                            <Bold>{chordLabel(RESUME_KEY)}</Bold>
                        </Fg>
                        <Fg role="fgMuted">{` ${resumeLabel()}`}</Fg>
                    </text>
                    <Show when={props.state === "retrying"}>
                        <text>
                            <Fg role="fgMuted">{` ${GLYPHS.middot} `}</Fg>
                        </text>
                        <text selectable={false} onMouseUp={() => onActionClick("hold")}>
                            <Fg role="accent">
                                <Bold>{chordLabel(HOLD_KEY)}</Bold>
                            </Fg>
                            <Fg role="fgMuted"> hold</Fg>
                        </text>
                    </Show>
                    <text>
                        <Fg role="fgMuted">{` ${GLYPHS.middot} `}</Fg>
                    </text>
                    <text selectable={false} onMouseUp={() => onActionClick("stop")}>
                        <Fg role="accent">
                            <Bold>{chordLabel(STOP_KEY)}</Bold>
                        </Fg>
                        <Fg role="fgMuted"> stop</Fg>
                    </text>
                    <Show when={props.othersWaiting > 0}>
                        <text>
                            <Fg role="fgMuted">{`  +${props.othersWaiting} more waiting`}</Fg>
                        </text>
                    </Show>
                </box>
            </box>
        </box>
    );
}
