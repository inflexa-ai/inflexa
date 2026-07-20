import { For, Show } from "solid-js";

import { GLYPHS, space } from "../../lib/design_system.ts";
import { Bold, Fg, Underline } from "./emphasis.tsx";

/** One resolved row of an openable card, as the block renders it (the caller does the resolution). */
export type OpenableRowView = {
    /** Row name (file basename, chart title, "Report vN"). */
    name: string;
    /** Optional one-line context beside the name (or the failure reason for a degraded row). */
    caption?: string;
    /** Resolved path shown for manual opening, or `null` when it could not be resolved. */
    path: string | null;
    /** True → render the degraded state (missing file, or nothing to open). */
    degraded: boolean;
};

/** Props for {@link OpenableCardBlock}. Purely presentational — the caller wires resolution + the opener. */
export type OpenableCardBlockProps = {
    /** Optional card heading. */
    title?: string;
    /** One row per openable item (a multi-file gallery has several). */
    rows: OpenableRowView[];
    /** When present, render a reveal-containing-folder affordance with this label (multi-file galleries). */
    folderLabel?: string;
    /** Open the entry at `index` (wired to a row click). */
    onOpen: (index: number) => void;
    /** Reveal the containing folder (wired to the folder affordance click). */
    onOpenFolder?: () => void;
};

/**
 * The openable-card block: pixel-shaped content a terminal cannot paint, rendered as a card whose rows
 * open externally. Optional title, then one row per entry (marker + name + optional caption) with the
 * resolved path on a dim, underlined line beneath — so manual opening is always possible even when the OS
 * opener fails. Each row is a click target wired to {@link OpenableCardBlockProps.onOpen}; a multi-file
 * gallery adds a folder-reveal affordance. Purely presentational — the caller resolves paths + owns the opener.
 *
 * The marker column answers exactly ONE question: does this row open, or is it broken? Every openable row
 * — the folder-reveal affordance included — carries the same `arrowUpRight`, so `cross` on a degraded row
 * (a missing file, a failed preview) reads as genuine contrast rather than as one more variant. Content
 * KIND is deliberately not depicted: a terminal's geometric shapes cannot separate chart from image from
 * document legibly, and every shape available here already carries an unrelated meaning elsewhere in the
 * app (the filled circle is a status dot and a plan marker, the right triangle is the running-tool marker).
 * The entry name and its file extension — `volcano.png`, `de-summary.csv` — distinguish kinds far better,
 * so kind lives in the text and the gutter stays a single unambiguous affordance.
 *
 * The title needs its own `fg` role because opentui's text renderable defaults to opaque white and `<Bold>`
 * sets an attribute only — an unpainted bold title is invisible against a light theme's background.
 */
export function OpenableCardBlock(props: OpenableCardBlockProps) {
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <Show when={props.title}>
                <text>
                    <Fg role="fg">
                        <Bold>{props.title}</Bold>
                    </Fg>
                </text>
            </Show>
            {/* Rows pad by space.md, landing in the same column as assistant body text. Deliberately NO
                left border rule — that's the quoted-content idiom reserved for user-authored turns, and
                these cards are agent-emitted content. */}
            <box paddingLeft={space.md} flexDirection="column">
                <For each={props.rows}>
                    {(row, index) => (
                        <box flexDirection="column" onMouseDown={() => props.onOpen(index())}>
                            <text>
                                <Fg role={row.degraded ? "error" : "accent"}>{`${row.degraded ? GLYPHS.cross : GLYPHS.arrowUpRight} `}</Fg>
                                <Fg role={row.degraded ? "fgMuted" : "fg"}>{row.name}</Fg>
                                <Show when={row.caption}>
                                    <Fg role="fgMuted">{` ${GLYPHS.middot} ${row.caption}`}</Fg>
                                </Show>
                            </text>
                            <text paddingLeft={space.md}>
                                <Fg role={row.degraded ? "error" : "fgMuted"}>
                                    <Underline>{row.path ?? (row.degraded ? "unavailable" : "path could not be resolved")}</Underline>
                                </Fg>
                            </text>
                        </box>
                    )}
                </For>
                <Show when={props.folderLabel && props.onOpenFolder}>
                    {/* The folder row opens externally like every other row, so it shares their marker; its
                        muted label and trailing position are what set it apart from the entries above. */}
                    <text onMouseDown={() => props.onOpenFolder?.()}>
                        <Fg role="accent">{`${GLYPHS.arrowUpRight} `}</Fg>
                        <Fg role="fgMuted">{props.folderLabel}</Fg>
                    </text>
                </Show>
            </box>
        </box>
    );
}
