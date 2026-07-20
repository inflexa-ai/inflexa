// WCAG 2.1 relative luminance + contrast ratio, hand-rolled rather than pulled from a package: it is
// twelve lines of arithmetic that must never drift between the two guards that measure it — the
// palette matrix (`lib/design_system.contrast.test.ts`, which measures declared token pairs) and the
// rendered-span sweep (`tui/theme_contrast.render.test.tsx`, which measures what a block ACTUALLY
// paints). Two copies of the formula could disagree and let a real regression through the seam.

/** Linearize one 8-bit sRGB channel to its light-intensity value, per WCAG 2.1's transfer function. */
function channel(v8: number): number {
    const c = v8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance of a `#rrggbb` color — the luminance-weighted sum of its linearized channels. */
function luminance(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/**
 * WCAG 2.1 contrast ratio between two `#rrggbb` colors, in `[1, 21]`. Symmetric: which color is the
 * foreground does not change the number, only which side of the ratio it lands on.
 */
export function contrast(fg: string, bg: string): number {
    const a = luminance(fg);
    const b = luminance(bg);
    const [hi, lo] = a >= b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
}
