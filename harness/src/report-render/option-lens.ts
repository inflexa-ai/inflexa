/**
 * Lenses for reading members of an `EchartOption`.
 *
 * `EchartOption` is `Record<string, unknown>` by design: the option is a plain
 * JSON-ish tree that ECharts interprets, and the module that builds it holds no
 * static model of every member. These lenses read that tree through zod, so a
 * member read states which shape it expects and a wrong tree fails at the read
 * with the path in the message, instead of through a cast that silences the
 * compiler.
 */
import { z } from "zod";

import type { Cell, EchartOption } from "./chart.js";

/**
 * An option member is whatever the builder wrote: ECharts members include function formatters and
 * callbacks, so no JSON-only schema admits the tree. The per-member checks of each lens decide the
 * shapes that matter; the member schema itself stays permissive by this module's design.
 */
const member = z.custom<unknown>(() => true);
const record = z.record(z.string(), member);
const records = z.array(record);

/** Reads a member the option holds as a record; fails the read when it does not. */
export function optionRecord(value: unknown): EchartOption {
    return record.parse(value);
}

/** Reads a member the option holds as an array of records; fails the read when it does not. */
export function optionRecords(value: unknown): EchartOption[] {
    return records.parse(value);
}

/** Reads a member that may be absent or hold another shape: yields `[]` when it is not a record array. */
export function optionRecordsOrEmpty(value: unknown): EchartOption[] {
    return records.catch([]).parse(value);
}

/**
 * Reads a member the option holds as an array of any shape: ECharts mixes records, pairs, and
 * scalars inside one member (`markLine.data`, `series.data`). Read each element through the lens
 * its shape needs.
 */
export function optionArray(value: unknown): unknown[] {
    return z.array(member).parse(value);
}

/** Reads a member that may be absent or hold another shape: yields `{}` so member reads stay safe. */
export function optionMember(value: unknown): EchartOption {
    return record.catch({}).parse(value);
}

/** Reads a member that may be absent or hold another shape: yields `undefined` when it is not a record. */
export function optionMemberOrUndefined(value: unknown): EchartOption | undefined {
    const parsed = record.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** Reads a member the option holds as an array of numbers; fails the read when it does not. */
export function optionNumbers(value: unknown): number[] {
    return z.array(z.number()).parse(value);
}

/** Reads a member the option holds as a number; fails the read when it does not. */
export function optionNumber(value: unknown): number {
    return z.number().parse(value);
}

/** Reads a member that may be absent or hold another shape: yields `undefined` when it is no number. */
export function optionNumberOrUndefined(value: unknown): number | undefined {
    const parsed = z.number().safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** Reads a member the option holds as a string; fails the read when it does not. */
export function optionString(value: unknown): string {
    return z.string().parse(value);
}

/** Reads a member the option holds as a name (a string, or a number ECharts labels with); fails the read when it holds neither. */
export function optionText(value: unknown): string {
    return z
        .union([z.string(), z.number()])
        .transform((value) => value.toString())
        .parse(value);
}

/** Reads a member the option holds as a percent or a plain number (`"10%"` or `10`); fails the read when it holds neither. */
export function optionPercent(value: unknown): number {
    return z.union([z.number(), z.string().transform((text) => Number.parseFloat(text))]).parse(value);
}

/** Reads a member the option holds as a boolean; fails the read when it does not. */
export function optionBoolean(value: unknown): boolean {
    return z.boolean().parse(value);
}

const cell = z.union([z.number(), z.string()]);

/** Reads a member the option holds as a cell (a number or a string); fails the read when it does not. */
export function optionCells(value: unknown): Cell[] {
    return z.array(cell).parse(value);
}

/** Reads one element of a mixed array as a cell, or `undefined` when it is neither: ECharts reads absent cells as empty. */
export function optionCell(value: unknown): Cell | undefined {
    const parsed = cell.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** Reads a member the option holds as an array of strings; fails the read when it does not. */
export function optionStrings(value: unknown): string[] {
    return z.array(z.string()).parse(value);
}

/** Reads a member the option holds as an array of record pairs (a mark area holds its two corners); fails the read when it does not. */
export function optionRecordPairs(value: unknown): [EchartOption, EchartOption][] {
    return z.array(z.tuple([record, record])).parse(value);
}

/** Reads a member the option holds as an array of nullable numbers; fails the read when it does not. */
export function optionNullableNumbers(value: unknown): (number | null)[] {
    return z.array(z.number().nullable()).parse(value);
}

/** Reads a member the option holds as an array of number arrays (a boxplot or a forest item); fails the read when it does not. */
export function optionNumberMatrix(value: unknown): number[][] {
    return z.array(z.array(z.number())).parse(value);
}

/** Reads a member the option holds as an array of arrays of unknown members (a dotplot item row); fails the read when it does not. */
export function optionUnknownMatrix(value: unknown): unknown[][] {
    return z.array(z.array(member)).parse(value);
}

const columnSource = z.object({ column: z.number() }).loose();
const seriesSource = z
    .object({
        x: columnSource,
        y: columnSource,
        color: columnSource.optional(),
        size: columnSource.optional(),
        group: columnSource.optional(),
        value: cell.optional(),
        category: z.number().optional(),
        label: z.number().optional(),
        flags: z.array(z.number()).optional(),
        sort: z.boolean().optional(),
        rise: z.boolean().optional(),
        swap: z.boolean().optional(),
    })
    .loose();
const chartSource = z
    .object({
        payload: z.string(),
        rule: record.optional(),
        series: z.array(seriesSource),
    })
    .loose();

/**
 * Reads the payload descriptor that a dense chart stamps into its option (the `__reportData` member),
 * or `undefined` when the option carries its rows.
 */
export function optionSource(value: unknown): z.output<typeof chartSource> | undefined {
    const parsed = chartSource.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}
