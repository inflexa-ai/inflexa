import { For, Show } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space } from "../../lib/design_system.ts";
import { Bold, Fg, Underline } from "./emphasis.tsx";
import type { OpenableIcon } from "../../types/session.ts";

/** One resolved row of an openable card, as the block renders it (the caller does the resolution). */
export type OpenableRowView = {
    /** Glyph shape for the row marker. */
    icon: OpenableIcon;
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

/** Map an entry's content-kind icon to a `GLYPHS` shape (glyphs never inline in components). */
function iconGlyph(icon: OpenableIcon): string {
    switch (icon) {
        case "chart":
            return GLYPHS.circleHalf;
        case "image":
            return GLYPHS.diamond;
        case "document":
            return GLYPHS.triangleRight;
        case "report":
            return GLYPHS.pencil;
        default: {
            const _exhaustive: never = icon;
            return _exhaustive;
        }
    }
}

/**
 * The openable-card block: pixel-shaped content a terminal cannot paint, rendered as a card whose rows
 * open externally. Optional title, then one row per entry (kind glyph + name + optional caption) with the
 * resolved path on a dim, underlined line beneath — so manual opening is always possible even when the OS
 * opener fails. A degraded row (missing file, or a failed preview) shows a `cross` marker and its reason
 * in `error` color. Each row is a click target wired to {@link OpenableCardBlockProps.onOpen}; a multi-file
 * gallery adds a folder-reveal affordance. Purely presentational — the caller resolves paths + owns the opener.
 */
export function OpenableCardBlock(props: OpenableCardBlockProps) {
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <Show when={props.title}>
                <text>
                    <Fg role="accent">{`${GLYPHS.circle} `}</Fg>
                    <Bold>{props.title}</Bold>
                </text>
            </Show>
            <box paddingLeft={space.md} flexDirection="column" border={["left"]} borderColor={theme().border}>
                <For each={props.rows}>
                    {(row, index) => (
                        <box flexDirection="column" onMouseDown={() => props.onOpen(index())}>
                            <text>
                                <Fg role={row.degraded ? "error" : "accent"}>{`${row.degraded ? GLYPHS.cross : iconGlyph(row.icon)} `}</Fg>
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
                    <text onMouseDown={() => props.onOpenFolder?.()}>
                        <Fg role="accent">{`${GLYPHS.triangleRight} `}</Fg>
                        <Fg role="fgMuted">{props.folderLabel}</Fg>
                    </text>
                </Show>
            </box>
        </box>
    );
}
