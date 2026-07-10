import { syntaxStyle, theme } from "../theme.ts";
import { GLYPHS, space, stroke, MARKERS } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** Props for {@link DiffBlock}. */
export type DiffBlockProps = {
    /** Edited file path. */
    path: string;
    /** A unified-diff string, rendered by the native `<diff>` renderable. */
    diff: string;
    /** Lines added. */
    added: number;
    /** Lines removed. */
    removed: number;
};

/**
 * The diff / file-edit block: the `✎` marker with the file path and +/− counts,
 * the hunk rendered by the native `<diff>` renderable (its own +/− gutters and
 * tint), and the accept/reject/edit affordance line.
 */
export function DiffBlock(props: DiffBlockProps) {
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role={MARKERS.fileEdit.role}>{`${MARKERS.fileEdit.glyph} `}</Fg>
                <Fg role="fg">{props.path}</Fg> <Fg role="success">{`+${props.added}`}</Fg> <Fg role="error">{`${GLYPHS.emDash}${props.removed}`}</Fg>
            </text>
            <box marginTop={space.sm} borderStyle={stroke.panel} borderColor={theme().border}>
                {/* Every color the `<diff>` renderable would otherwise hardcode is pinned to the active theme:
                    without `fg`/`syntaxStyle` its lines render in opentui's white default (invisible on light
                    themes), and its band/sign/line-number defaults are a dark-only design (`#1a4d1a`/`#4d1a1a`
                    bands, `#888888` numbers) that looks wrong on light themes and fails AA. `diffAddedBg`/
                    `diffRemovedBg` are per-theme tints; signs and line numbers reuse `success`/`error`/`fgMuted`
                    (no dedicated tokens). */}
                <diff
                    diff={props.diff}
                    fg={theme().fg}
                    syntaxStyle={syntaxStyle()}
                    addedBg={theme().diffAddedBg}
                    removedBg={theme().diffRemovedBg}
                    addedSignColor={theme().success}
                    removedSignColor={theme().error}
                    lineNumberFg={theme().fgMuted}
                />
            </box>
            <text fg={theme().fgMuted}>
                a accept {GLYPHS.middot} r reject {GLYPHS.middot} e edit
            </text>
        </box>
    );
}
