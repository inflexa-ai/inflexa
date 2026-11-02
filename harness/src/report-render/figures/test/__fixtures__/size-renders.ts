/**
 * The page render and the export render of each export size, with the frame where its text places. The
 * overlap suites of the figures read one render per size from this table.
 */

import type { EchartOption } from "../../../chart.js";
import { CHART_EXPORT_SIZES } from "../../../design.js";
import { EXPORT_PLOT_FRAMES, PAGE_PLOT_FRAME, type NameFrame } from "../../label-room.js";

/** The export sizes under test, in the order of the table. */
const EXPORT_KINDS = ["single", "double", "slide"] as const satisfies readonly (keyof typeof CHART_EXPORT_SIZES)[];

/** The page option, and the export option of each export size, with the frame where its text places. */
export function sizeRenders(
    option: EchartOption,
    exportOption: (option: EchartOption, textPx: number, widthPx: number, heightPx: number) => EchartOption,
): Array<readonly [string, EchartOption, NameFrame]> {
    return [
        ["page", option, PAGE_PLOT_FRAME],
        ...EXPORT_KINDS.map(
            (kind) =>
                [
                    kind,
                    exportOption(option, CHART_EXPORT_SIZES[kind].textPx, CHART_EXPORT_SIZES[kind].widthPx, CHART_EXPORT_SIZES[kind].heightPx),
                    EXPORT_PLOT_FRAMES[kind],
                ] as const,
        ),
    ];
}
