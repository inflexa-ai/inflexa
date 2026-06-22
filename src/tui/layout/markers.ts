import type { ThemeColors } from "../../lib/themes.ts";

/** A gutter block kind — the marker that prefixes each stream block in the fixed gutter column. */
export type MarkerKind = "you" | "assistant" | "thinking" | "tool" | "run" | "fileEdit" | "ok" | "error";

/** A gutter marker: its glyph and the theme color role that paints it. */
export type GutterMarker = {
    /** The single-character glyph shown in the fixed gutter column. */
    glyph: string;
    /** An existing `ThemeColors` role (no new tokens) used to color the glyph. */
    role: keyof ThemeColors;
};

/**
 * The shared gutter marker set (the wireframe "shared kit"). One fixed glyph + color role per
 * block kind, so every block type aligns in the same gutter column with only the marker swapping.
 * `MessageBlock` uses the `you`/`assistant` entries today; the remaining six are defined now for
 * the not-yet-built "key moment" block types (thinking / tool / run / file edit / ok / error).
 */
export const MARKERS: Record<MarkerKind, GutterMarker> = {
    you: { glyph: ">", role: "user" },
    assistant: { glyph: "<", role: "assistant" },
    thinking: { glyph: "◆", role: "warn" },
    tool: { glyph: "▸", role: "muted" },
    run: { glyph: "●", role: "warn" },
    fileEdit: { glyph: "✎", role: "success" },
    ok: { glyph: "✓", role: "success" },
    error: { glyph: "✗", role: "error" },
};
