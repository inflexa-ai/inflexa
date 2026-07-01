import { theme } from "../theme.ts";
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
                <diff diff={props.diff} />
            </box>
            <text fg={theme().fgSubtle}>
                a accept {GLYPHS.middot} r reject {GLYPHS.middot} e edit
            </text>
        </box>
    );
}
