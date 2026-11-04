import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { GLYPHS, space } from "../../lib/design_system.ts";
import type { ThemeColors } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { Bold, Fg, Underline } from "./emphasis.tsx";
import { ErrorBlock } from "./error_block.tsx";

/** How well the search filled one analogy. Mirrors the harness `coverage` values. */
export type AnalogyCoverageView = "available" | "queried_no_data" | "search_failed" | "not_loaded";

/** One cited solution of an analogy. */
export type AnalogySolutionView = {
    title: string;
    /** How the method transfers back to the source problem. */
    relevance: string;
    /** The URLs of the cited papers and repositories. */
    sources: string[];
};

/** One analogy of the report. */
export type AnalogyView = {
    domain: string;
    title: string;
    coverage: AnalogyCoverageView;
    mappings: { source: string; target: string }[];
    solutions: AnalogySolutionView[];
};

/** What the block renders: a report, or the message of a report that the reasoner could not make. */
export type AnalogyReportView = { kind: "report"; problem: string; analogies: AnalogyView[] } | { kind: "failed"; message: string };

/** Props for {@link AnalogyReportBlock}. */
export type AnalogyReportBlockProps = {
    view: AnalogyReportView;
    /** The state at mount. The block owns the toggle after that. Absent reads as collapsed. */
    expanded?: boolean;
};

const COVERAGE_TAGS: Record<Exclude<AnalogyCoverageView, "available">, { label: string; role: keyof ThemeColors }> = {
    queried_no_data: { label: "no data", role: "fgMuted" },
    not_loaded: { label: "not loaded", role: "fgMuted" },
    search_failed: { label: `${GLYPHS.cross} search failed`, role: "error" },
};

/**
 * The analogy report block. The header line names the counts and toggles the block on a click. Collapsed, the
 * block shows the problem, each analogy with its coverage, and the title of each solution. Expanded, it also
 * shows the object mappings, the relevance of each solution, and its sources. A failed report is an
 * {@link ErrorBlock} with the message as its detail, and it does not toggle. The toggle is mouse only, because the transcript has no focus that can target one block.
 */
export function AnalogyReportBlock(props: AnalogyReportBlockProps): JSX.Element {
    // oxlint-disable-next-line solid/reactivity -- seed-once: `expanded` sets the state at mount, and a click owns it after that
    const [open, setOpen] = createSignal(props.expanded ?? false);
    return (
        <Show
            when={props.view.kind === "report" ? props.view : undefined}
            fallback={<ErrorBlock summary="Analogy report failed" detail={props.view.kind === "failed" ? props.view.message : undefined} />}
        >
            {(report) => {
                const filled = (): number => report().analogies.filter((analogy) => analogy.solutions.length > 0).length;
                // Two analogies can share a target domain, thus the header counts the distinct domains.
                const domains = (): number => new Set(report().analogies.map((analogy) => analogy.domain)).size;
                const count = (): string => `${domains()} ${domains() === 1 ? "domain" : "domains"}`;
                const filledCount = (): string => `${filled()} ${filled() === 1 ? "analogy" : "analogies"} with solutions`;
                return (
                    <box flexDirection="column" paddingBottom={space.sm}>
                        <text selectable={false} onMouseDown={() => setOpen(!open())}>
                            <Fg role="accent">{`${open() ? GLYPHS.triangleDown : GLYPHS.triangleRight} `}</Fg>
                            <Fg role="fg">
                                <Bold>Analogies</Bold>
                            </Fg>
                            <Fg role="fgMuted">{` ${GLYPHS.middot} ${count()} ${GLYPHS.middot} ${filledCount()}`}</Fg>
                        </text>
                        <text fg={theme().fg} paddingLeft={space.md}>
                            <Fg role="fgMuted">for: </Fg>
                            {report().problem}
                        </text>
                        <For each={report().analogies}>
                            {(analogy, index) => (
                                <box flexDirection="column" paddingLeft={space.md} paddingTop={space.sm}>
                                    <text fg={theme().fg}>
                                        <Fg role="accent">{`${index() + 1} `}</Fg>
                                        <Bold>{analogy.domain}</Bold>
                                        <Fg role="fgMuted">{` ${GLYPHS.middot} `}</Fg>
                                        {analogy.title}
                                        <Show when={analogy.coverage !== "available" ? COVERAGE_TAGS[analogy.coverage] : undefined}>
                                            {(tag) => <Fg role={tag().role}>{`  ${tag().label}`}</Fg>}
                                        </Show>
                                    </text>
                                    <Show when={open() && analogy.mappings.length > 0}>
                                        <text fg={theme().fgMuted} paddingLeft={space.md}>
                                            {analogy.mappings
                                                .map((mapping) => `${mapping.source} ${GLYPHS.arrowRight} ${mapping.target}`)
                                                .join(` ${GLYPHS.middot} `)}
                                        </text>
                                    </Show>
                                    <For each={analogy.solutions}>
                                        {(solution) => (
                                            <box flexDirection="column" paddingLeft={space.md}>
                                                <text fg={theme().fg}>{solution.title}</text>
                                                <Show when={open()}>
                                                    <box flexDirection="column" paddingLeft={space.md}>
                                                        <text fg={theme().fgMuted}>{solution.relevance}</text>
                                                        <For each={solution.sources}>
                                                            {(source) => (
                                                                <text>
                                                                    <Fg role="fgMuted">
                                                                        <Underline>{source}</Underline>
                                                                    </Fg>
                                                                </text>
                                                            )}
                                                        </For>
                                                    </box>
                                                </Show>
                                            </box>
                                        )}
                                    </For>
                                </box>
                            )}
                        </For>
                    </box>
                );
            }}
        </Show>
    );
}
