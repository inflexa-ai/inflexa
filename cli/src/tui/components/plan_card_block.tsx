import { createMemo, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";

import { theme } from "../theme.ts";
import { GLYPHS, size, space } from "../../lib/design_system.ts";
import { planToDag } from "../../modules/harness/plan_dag.ts";
import { Fg } from "./emphasis.tsx";
import { ScrollPane } from "./scroll_pane.tsx";
import type { PlanCardStepView } from "../../types/session.ts";

// Label widths tried from roomiest to tightest when fitting the DAG to the terminal. The first that
// fits the content budget wins; if even the tightest overflows, the card degrades to the vertical
// step list (which is one step per line, so it fits any width). Mirrors plan_dag's own 24 default at
// the top so a wide terminal keeps full names.
const DAG_NAME_WIDTHS = [24, 18, 14, 10, 8] as const;

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
 * The plan-card block: a `●` marker with the plan title and id, then the plan body indented beneath.
 * The body is the dependency graph when it fits the terminal, otherwise one line per step
 * (`id name [agent]`). Responsive: the graph re-renders at the widest label size that fits and
 * degrades to the flat list on a narrow terminal (see {@link DAG_NAME_WIDTHS}). The card carries only
 * the primitive fields the harness `readPlanCard` reader extracts; it never holds a harness object.
 */
export function PlanCardBlock(props: PlanCardBlockProps) {
    const dims = useTerminalDimensions();
    const heading = (): string => props.title || props.planId;
    // Columns the DAG may occupy: the terminal width less the (possibly open) sidebar rail, this
    // card's own indent, and the stream gutter. Reserved conservatively so a graph that would overflow
    // degrades to the list instead of spilling past the viewport — a closed sidebar just leaves slack,
    // and under-budgeting only ever shortens labels or falls back early, never overflows.
    const contentWidth = (): number => Math.max(24, dims().width - size.railWidth - space.md - size.gutter);
    // The widest label size whose rendered graph fits `contentWidth`, or null when even the tightest
    // overflows (→ the vertical list fallback). Re-rendering the DAG per candidate keeps the fit
    // decision here and leaves plan_dag oblivious to the viewport; the grids are small, so the few
    // extra passes are cheap and only recompute when the steps or terminal width change.
    const graph = createMemo((): string | null => {
        if (props.steps.length === 0) return null;
        const budget = contentWidth();
        for (const maxNameLength of DAG_NAME_WIDTHS) {
            const rendered = planToDag(props.steps, { maxNameLength }).match(
                (value) => value || null,
                () => null,
            );
            if (!rendered) return null;
            const widest = Math.max(0, ...rendered.split("\n").map((line) => line.length));
            if (widest <= budget) return rendered;
        }
        return null;
    });
    const graphHeight = (): number => (graph()?.split("\n").length ?? 0) + 1;
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role="accent">{`${GLYPHS.circle} `}</Fg>
                <Fg role="fg">{heading()}</Fg>
                {/* Show the id beside the title only when the title is what's already displayed —
                    otherwise the heading IS the id and repeating it is noise. */}
                <Show when={props.title}>
                    <Fg role="fgMuted">{` ${GLYPHS.middot} ${props.planId}`}</Fg>
                </Show>
            </text>
            <box paddingLeft={space.md} flexDirection="column">
                <Show
                    when={graph()}
                    fallback={
                        <For each={props.steps}>
                            {(step) => (
                                <text>
                                    <Fg role="fgMuted">{`${step.id} `}</Fg>
                                    <Fg role="fg">{step.name}</Fg>
                                    <Fg role="tool">{` [${step.agent}]`}</Fg>
                                </text>
                            )}
                        </For>
                    }
                >
                    {(value: Accessor<string>) => (
                        <ScrollPane focusOnMount={false} height={graphHeight()} width="100%" scrollX scrollY={false}>
                            {/* The graph is one text blob (frame + labels), so it takes a single color.
                                theme().fg is the AA-safe choice — plain text on every theme; leaving fg
                                unset fell through to opentui's #FFFFFF, invisible on light themes. */}
                            <text wrapMode="none" fg={theme().fg}>
                                {value()}
                            </text>
                        </ScrollPane>
                    )}
                </Show>
            </box>
        </box>
    );
}
