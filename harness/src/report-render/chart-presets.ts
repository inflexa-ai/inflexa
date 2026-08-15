/**
 * The preset expansion of the chart grammar.
 *
 * A preset is sugar over the composition. `expandPreset` gives the composition of one preset, thus the
 * derivation reads one shape and the two paths cannot drift.
 *
 * Each default of a preset is a declared constant of this module. A guide line carries such a constant,
 * and a guide is never a plotted value. The expansion estimates nothing: the `km` preset plots the
 * precomputed survival columns as they are, and it fits no survival curve.
 *
 * A preset declares its own transform on the channel that it transforms. Thus it reads the column of that
 * channel and it drops an authored transform there, and no value takes the transform two times.
 */

import {
    channelColumn,
    channelTransform,
    type ChartAxes,
    type ChartChannel,
    type ChartComposition,
    type ChartEncoding,
    type ChartType,
} from "../contracts/report-blocks.js";

/** The four chart types that expand into a composition. */
export const PRESET_CHART_TYPES = ["volcano", "manhattan", "ma", "km"] as const;

/** One chart type that expands into a composition. */
export type PresetChartType = (typeof PRESET_CHART_TYPES)[number];

/** The p-value threshold of a volcano. The guide line sits at the transformed value of it. */
export const VOLCANO_P_THRESHOLD = 0.05;

/** The effect threshold of a volcano. One guide line sits at each side of zero. */
export const VOLCANO_EFFECT_THRESHOLD = 1;

/** The genome-wide significance threshold of a Manhattan plot. */
export const MANHATTAN_P_THRESHOLD = 5e-8;

/** The baseline of an MA plot. A point above it rose, and a point below it fell. */
export const MA_BASELINE = 0;

/** True when the chart type expands into a composition. */
export function isPresetChartType(chartType: ChartType): chartType is PresetChartType {
    // The array holds the four preset members, thus the test never reads a base type as a preset.
    return (PRESET_CHART_TYPES as readonly string[]).includes(chartType);
}

/**
 * Expand one preset into a composition.
 *
 * `x` and `y` are the two channels that every preset demands. The caller resolves them from the encoding
 * and refuses an absent one, thus this function is total and it needs no failure channel. `encoding`
 * supplies the optional `group` and `label` channels.
 */
export function expandPreset(preset: PresetChartType, x: ChartChannel, y: ChartChannel, encoding: ChartEncoding): ChartComposition {
    switch (preset) {
        case "volcano":
            return volcano(x, y, encoding);
        case "manhattan":
            return manhattan(x, y, encoding);
        case "ma":
            return ma(x, y, encoding);
        case "km":
            return km(x, y, encoding);
    }
}

/**
 * The effect on x, the transformed p-value on y, and three guide lines.
 *
 * The two effect guides sit at each side of zero, and the p guide sits at the transformed threshold. The
 * expression of the guide is the expression of the `neg_log10` transform, thus the guide and the points
 * share one scale.
 */
function volcano(x: ChartChannel, y: ChartChannel, encoding: ChartEncoding): ChartComposition {
    const pColumn = channelColumn(y);
    return {
        series: [
            {
                form: "scatter",
                encoding: { x, y: { column: pColumn, transform: "neg_log10" }, ...optionalChannels(encoding) },
            },
        ],
        annotations: [
            { kind: "reference-line", axis: "y", value: -Math.log10(VOLCANO_P_THRESHOLD), label: `p ${VOLCANO_P_THRESHOLD}` },
            { kind: "reference-line", axis: "x", value: -VOLCANO_EFFECT_THRESHOLD },
            { kind: "reference-line", axis: "x", value: VOLCANO_EFFECT_THRESHOLD },
        ],
        axes: plainTitle(x),
    };
}

/** The genome position on x, the transformed p-value on y, and the genome-wide guide line. */
function manhattan(x: ChartChannel, y: ChartChannel, encoding: ChartEncoding): ChartComposition {
    const pColumn = channelColumn(y);
    return {
        series: [
            {
                form: "scatter",
                encoding: { x, y: { column: pColumn, transform: "neg_log10" }, ...optionalChannels(encoding) },
            },
        ],
        annotations: [{ kind: "reference-line", axis: "y", value: -Math.log10(MANHATTAN_P_THRESHOLD), label: `p ${MANHATTAN_P_THRESHOLD}` }],
        axes: plainTitle(x),
    };
}

/** The mean level on x, the effect on y, and the baseline guide line. */
function ma(x: ChartChannel, y: ChartChannel, encoding: ChartEncoding): ChartComposition {
    return {
        series: [{ form: "scatter", encoding: { x, y, ...optionalChannels(encoding) } }],
        annotations: [{ kind: "reference-line", axis: "y", value: MA_BASELINE }],
    };
}

/**
 * The time on x and the precomputed survival on y, as one step series for each arm.
 *
 * A survival curve holds its value between two events, thus the step form is the honest one. The quick
 * path carries two channels for the two axes and no channel for a confidence bound. Thus a band around a
 * curve is a composition, where an `area` series names the upper bound on `y` and the lower bound on `y0`.
 */
function km(x: ChartChannel, y: ChartChannel, encoding: ChartEncoding): ChartComposition {
    return {
        series: [{ form: "step", encoding: { x, y, ...optionalChannels(encoding) } }],
    };
}

/**
 * The x title of a preset.
 *
 * A preset titles the x axis with the column that feeds it. A channel that carries a transform plots a
 * derived quantity, thus the column name would state the wrong one. Such a channel takes no title, and the
 * derived name of the renderer states the true quantity. The y axis of a preset that transforms its p
 * column takes no title for the same reason.
 */
function plainTitle(x: ChartChannel): ChartAxes {
    return channelTransform(x) === undefined ? { x: { title: channelColumn(x) } } : {};
}

/** The two optional channels that every preset carries through from the quick-path encoding. */
function optionalChannels(encoding: ChartEncoding): { group?: ChartChannel; label?: string } {
    return {
        ...(encoding.group !== undefined ? { group: encoding.group } : {}),
        ...(encoding.label !== undefined ? { label: encoding.label } : {}),
    };
}
