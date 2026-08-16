/**
 * The data-script payload of one table block.
 *
 * A table of many thousands of rows stamped into the markup makes a page of many megabytes. A `fetch` is
 * refused on a `file://` page, thus a data file cannot load the way an image does. A classic script asset
 * loads on any page, and the payload registers itself under one global map when the browser runs it.
 *
 * The encode is columnar. The rows are arrays in column order, thus no row repeats the column names. A
 * string that occurs more than one time in a column moves into the dictionary of that column, and each
 * cell that holds it becomes its index. A category column of one thousand rows and four values then costs
 * four strings and one thousand small integers.
 *
 * The module is pure, and it reads no file. The renderer derives a payload, and the caller writes it.
 */

import { createHash } from "node:crypto";

import { scriptJson } from "./script-json.js";

/**
 * The global map that each payload registers under, keyed by the block id.
 *
 * The page script reads the same name, thus the payload and the reader cannot disagree over a rename.
 */
export const TABLE_DATA_GLOBAL = "__REPORT_TABLES";

/** One cell of an encoded row: a raw value, a dictionary index, or `null` for a cell that the row lacks. */
export type EncodedCell = string | number | null;

/**
 * One encoded table.
 *
 * `columns` is the column order, and each row of `rows` holds one cell for each column in that order.
 * `dict` holds the repeated values of a column, keyed by the column name. A cell of such a column is a
 * number when it names an entry of that list, and the value itself at every other time.
 */
export interface TablePayload {
    columns: string[];
    rows: EncodedCell[][];
    dict: Record<string, string[]>;
}

/** One data asset that the caller writes beside the page: the staged file name, and the source text of it. */
export interface DataAsset {
    name: string;
    bytes: string;
}

/** The count of hash characters in an asset name. It matches the sidecar of an artifact, thus one form reads across the directory. */
const HASH_CHARS = 12;

/**
 * The dictionary of one column, or `undefined` when the column takes none.
 *
 * A column takes a dictionary when every cell of it is a string. The condition keeps the decode
 * unambiguous: a number in such a column can only be an index, and a string can only be a value. A column
 * that holds one number rides raw, thus no reader must tell an index from a measurement.
 *
 * The dictionary holds each string that occurs more than one time, in first-appearance order. A string
 * that occurs one time saves nothing as an entry, thus it stays in its row. The order is a function of the
 * rows alone, thus one table gives one dictionary and two encodes of it match.
 */
function columnDictionary(rows: ReadonlyArray<Record<string, string | number>>, column: string): string[] | undefined {
    const counts = new Map<string, number>();
    for (const row of rows) {
        const cell = row[column];
        if (typeof cell !== "string") {
            return undefined;
        }
        counts.set(cell, (counts.get(cell) ?? 0) + 1);
    }
    const repeated: string[] = [];
    for (const [value, count] of counts) {
        if (count > 1) {
            repeated.push(value);
        }
    }
    return repeated.length > 0 ? repeated : undefined;
}

/**
 * Encode a resolved table into its payload.
 *
 * The caller gives the column order, and the header of the card reads that same order. Thus the position
 * of a cell in a row names its column.
 *
 * A cell that a row does not hold rides as `null`. A table tolerates a ragged row, thus the payload states
 * the absence in place and never shifts the rest of the row.
 */
export function encodeTablePayload(columns: readonly string[], rows: ReadonlyArray<Record<string, string | number>>): TablePayload {
    const dict: Record<string, string[]> = {};
    const indexes = new Map<string, Map<string, number>>();
    for (const column of columns) {
        const values = columnDictionary(rows, column);
        if (values === undefined) {
            continue;
        }
        dict[column] = values;
        indexes.set(column, new Map(values.map((value, index) => [value, index])));
    }

    const encodedRows = rows.map((row) =>
        columns.map((column): EncodedCell => {
            const cell = row[column];
            if (cell === undefined) {
                return null;
            }
            // A dictionary column holds strings alone, thus a cell of another type never carries an index.
            const index = typeof cell === "string" ? indexes.get(column)?.get(cell) : undefined;
            return index === undefined ? cell : index;
        }),
    );
    return { columns: [...columns], rows: encodedRows, dict };
}

/**
 * The source text of one payload asset.
 *
 * The text assigns into the global map under the block id. The map takes the null-prototype form, thus a
 * block id such as `constructor` stays an ordinary entry. The block id and each cell ride as JSON, thus
 * hostile text is data and never source.
 */
function payloadSource(blockId: string, payload: TablePayload): string {
    const registry = `window.${TABLE_DATA_GLOBAL}`;
    return `${registry}=${registry}||Object.create(null);${registry}[${scriptJson(blockId)}]=${scriptJson(payload)};\n`;
}

/**
 * The data asset of one table block: the content-addressed file name, and the source text.
 *
 * The name carries the hash of the bytes, in the content-address style of a staged figure. Thus two
 * previews of unchanged data give one name, a changed table gives a new name, and the sweep of the stage
 * removes the name that nothing references any more.
 */
export function tableDataAsset(blockId: string, payload: TablePayload): DataAsset {
    const bytes = payloadSource(blockId, payload);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, HASH_CHARS);
    return { name: `t-${hash}.data.js`, bytes };
}
