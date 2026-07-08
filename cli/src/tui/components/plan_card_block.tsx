import { For, Show } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** One plan step's display shape — the three primitive fields the plan card carries per step. */
export type PlanCardStepView = {
    /** The plan-local step id (e.g. `s1`). */
    id: string;
    /** Human step name. */
    name: string;
    /** The sandbox agent that runs the step. */
    agent: string;
};

/** Props for {@link PlanCardBlock}. */
export type PlanCardBlockProps = {
    /** The stored plan's id — shown beside the title (and as the heading when the title is empty). */
    planId: string;
    /** Plan title; falls back to the id when the harness card carries none. */
    title: string;
    /** Ordered plan steps, each rendered as one line. */
    steps: PlanCardStepView[];
};

/**
 * The plan-card block: a `●` marker with the plan title and id, then one indented line per step
 * (`id name [agent]`) under a left rule — the same shape family as {@link RunBlock}'s step list.
 * The card carries only the primitive fields the harness `readPlanCard` reader extracts; it never
 * holds a harness object.
 */
export function PlanCardBlock(props: PlanCardBlockProps) {
    const heading = (): string => props.title || props.planId;
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role="accent">{`${GLYPHS.circle} `}</Fg>
                <Fg role="fg">{heading()}</Fg>
                {/* Show the id beside the title only when the title is what's already displayed —
                    otherwise the heading IS the id and repeating it is noise. */}
                <Show when={props.title}>
                    <Fg role="fgSubtle">{` ${GLYPHS.middot} ${props.planId}`}</Fg>
                </Show>
            </text>
            <box paddingLeft={space.md} flexDirection="column" border={["left"]} borderColor={theme().border}>
                <For each={props.steps}>
                    {(step) => (
                        <text>
                            <Fg role="fgSubtle">{`${step.id} `}</Fg>
                            <Fg role="fg">{step.name}</Fg>
                            <Fg role="tool">{` [${step.agent}]`}</Fg>
                        </text>
                    )}
                </For>
            </box>
        </box>
    );
}
