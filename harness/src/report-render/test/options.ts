/**
 * The typed reads that a report-render test makes over a produced ECharts option.
 *
 * An accessor fails the test when a present value carries the wrong shape. It never filters a malformed
 * entry away and never invents a default, so an assertion reads the option that the renderer built.
 */

import { isUnknownArray } from "../../lib/unknown-array.js";
import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import { CHART_SOURCE_MEMBER, type EchartOption } from "../chart.js";

function fail(what: string, value: unknown): never {
    const shown = JSON.stringify(value)?.slice(0, 80) ?? String(value);
    throw new Error(`the produced option holds ${what} in another shape: ${shown}`);
}

/** The option object that a value holds, or a failed test. */
export function optionOf(value: unknown): EchartOption {
    const option = parseUnknownRecord(value);
    if (option === undefined) fail("an option object", value);
    return option;
}

/** The series of an option, each entry an option object. */
export function seriesOf(option: EchartOption): EchartOption[] {
    if (!isUnknownArray(option.series)) fail("a series array", option.series);
    return option.series.map((entry) => optionOf(entry));
}

/** The array of option objects that the named member holds, each entry an option object. */
export function optionArray(option: EchartOption, key: string): EchartOption[] {
    if (!isUnknownArray(option[key])) fail(`a ${key} array`, option[key]);
    return option[key].map((entry) => optionOf(entry));
}

/** The option object that the named member holds, or a failed test. */
export function optionAt(option: EchartOption, key: string): EchartOption {
    return optionOf(option[key]);
}

/** The number that a value holds, or a failed test. */
export function optionNumber(value: unknown): number {
    if (typeof value !== "number") fail("a number", value);
    return value;
}

/** The array of numbers that a value holds, or a failed test. */
export function optionNumbers(value: unknown): number[] {
    if (!isUnknownArray(value)) fail("a number array", value);
    return value.map((entry) => optionNumber(entry));
}

/** The array of number arrays that a value holds, or a failed test. */
export function optionNumberRows(value: unknown): number[][] {
    if (!isUnknownArray(value)) fail("a number matrix", value);
    return value.map((entry) => optionNumbers(entry));
}

/** The grid of an option at an index, or a failed test. */
export function gridAt(option: EchartOption, index: number): EchartOption {
    return optionEntry(optionArray(option, "grid"), index, "grid");
}

/** The option object that a list holds at an index, or a failed test. */
export function optionEntry(options: EchartOption[], index: number, what: string): EchartOption {
    const entry = options[index];
    if (entry === undefined) fail(`a ${what} at index ${index}`, entry);
    return entry;
}

/** The data of the mark line of an option: empty when the option holds no mark line. The entries stay as
 * the renderer built them, because one mark line mixes guide objects with pairs of line ends. */
export function markLineData(option: EchartOption): unknown[] {
    const line = optionMaybe(option, "markLine");
    return line === undefined ? [] : optionList(line.data);
}

/** The array that a value holds, or a failed test. */
export function optionList(value: unknown): unknown[] {
    if (!isUnknownArray(value)) fail("an array", value);
    return value;
}

/** The option object that the named member holds when the member is present, or `undefined`. */
export function optionMaybe(option: EchartOption, key: string): EchartOption | undefined {
    return option[key] === undefined ? undefined : optionAt(option, key);
}

/** The array of strings that a value holds, or a failed test. */
export function optionStrings(value: unknown): string[] {
    if (!isUnknownArray(value)) fail("a string array", value);
    return value.map((entry) => {
        if (typeof entry !== "string") fail("a string", entry);
        return entry;
    });
}

/** The rows of option pairs that a mark line holds, or a failed test. */
export function optionPairRows(value: unknown): Array<[EchartOption, EchartOption]> {
    if (!isUnknownArray(value)) fail("a pair-row array", value);
    return value.map((row) => {
        const entries = optionList(row).map((entry) => optionOf(entry));
        const [from, to] = entries;
        if (from === undefined || to === undefined) fail("a pair of options", row);
        return [from, to];
    });
}

/** The array of option objects that a value holds, or a failed test. */
export function optionsOf(value: unknown): EchartOption[] {
    if (!isUnknownArray(value)) fail("an option array", value);
    return value.map((entry) => optionOf(entry));
}

/** The pair of numbers that a value holds, or a failed test. */
export function optionPair(value: unknown): [number, number] {
    const [first, second] = optionNumbers(value);
    if (first === undefined || second === undefined) fail("a pair of numbers", value);
    return [first, second];
}

/** The function that the page source builds under the given name, called with unknown arguments. */
export function pageCall(source: string, name: string): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => {
        const made: unknown = new Function(`${source}\nreturn ${name};`).call(undefined);
        if (typeof made !== "function") throw new Error(`the page source holds no ${name}`);
        const given: unknown = Reflect.apply(made, undefined, args);
        return given;
    };
}

/** The data source of one dense chart: the payload name, the rule, and one option object per series. */
export function chartSourceOf(option: EchartOption): { payload: string; rule: unknown; series: EchartOption[] } {
    const source = optionOf(option[CHART_SOURCE_MEMBER]);
    if (typeof source.payload !== "string") fail("a payload name", source.payload);
    if (!isUnknownArray(source.series)) fail("a series array", source.series);
    return { payload: source.payload, rule: source.rule, series: source.series.map((entry) => optionOf(entry)) };
}
