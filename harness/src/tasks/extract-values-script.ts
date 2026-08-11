/**
 * The fixed extraction script and its wire protocol.
 *
 * The extraction arm runs this one Python script in the sandbox. The script reads one JSON input: a list
 * of path, format, and hash triples. For each triple the script hashes the file bytes with a streamed
 * sha256 before any read. If the on-disk hash does not match the pinned hash, the script refuses the file
 * as a typed error. If the hash matches, the script reads the file from the read-only analysis mount, and
 * it parses the file by the carried format. A parquet file uses pyarrow. The script emits one JSON map:
 * each path to its rows, or to a typed error. The script decides nothing else. It applies no filter and no
 * projection.
 *
 * The host decides the format one time, and the request carries it. Thus the script derives no reader from
 * an extension, and it refuses a request that names no format. The JSON arm obeys the strict host shape, an
 * array of flat objects, thus a shape that the host refuses is a refusal here too and it never comes back
 * as a table that pandas inferred.
 *
 * The harness holds the script as a string constant, thus the package ships no separate asset file. The
 * script reaches the container as the argument of `python3 -c`. The input reaches the container as one
 * environment variable.
 */

import { z } from "zod";

/**
 * The environment variable that carries the script input. The workflow body sets it to the JSON list of
 * path, format, and hash triples. The script reads it back one time.
 */
export const EXTRACTION_INPUT_ENV = "CORTEX_EXTRACTION_REQUESTS";

/**
 * One artifact row, as plain cells. A text-backed format holds a numeric column as a string, thus a cell
 * is a string or a number.
 */
const ExtractionRowSchema = z.record(z.string(), z.union([z.string(), z.number()]));
export type ExtractionRow = z.infer<typeof ExtractionRowSchema>;

/**
 * The outcome for one path. A clean read gives the rows. A per-file read fault gives a typed error, and
 * the script still emits the map. The arm keeps the rows and drops the error, thus a failed path reads as
 * an unread artifact downstream.
 */
const ExtractOutcomeSchema = z.union([
    z.object({ rows: z.array(ExtractionRowSchema) }),
    z.object({ error: z.object({ type: z.string(), message: z.string() }) }),
]);
export type ExtractOutcome = z.infer<typeof ExtractOutcomeSchema>;

/** The script output: each requested path to its outcome. */
export const ExtractValuesResultSchema = z.record(z.string(), ExtractOutcomeSchema);
export type ExtractValuesResult = z.infer<typeof ExtractValuesResultSchema>;

/**
 * The one extraction script. The workflow body runs it as the argument of `python3 -c`. The script reads
 * the request list from `CORTEX_EXTRACTION_REQUESTS`, and it emits the value map to stdout.
 *
 * The Python comments obey the same Simplified Technical English rule as the harness comments.
 */
export const EXTRACTION_SCRIPT = `import hashlib
import json
import math
import os
import sys

import pandas as pd


def sha256_of(path):
    # The host pins the exact bytes with a streamed sha256, in the "sha256:<hex>" form. Mirror that form
    # here, and stream the file in blocks, thus a large file never loads fully into memory.
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return "sha256:" + digest.hexdigest()


def coerce_cell(value):
    # A null cell becomes None, thus the record drops the key.
    if value is None:
        return None
    # A numpy scalar becomes a plain Python scalar.
    if hasattr(value, "item"):
        try:
            value = value.item()
        except (ValueError, TypeError):
            return str(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return value
    return str(value)


def read_frame(path, fmt):
    # pyarrow reads the parquet columnar format.
    if fmt == "parquet":
        return pd.read_parquet(path, engine="pyarrow")
    if fmt == "tsv":
        # keep_default_na=False keeps a literal cell such as "NA" or an empty string as its text, and the
        # host parser keeps it too. A default read turns each into NaN, and the row builder drops the key.
        return pd.read_csv(path, sep="\\t", dtype=str, keep_default_na=False)
    if fmt == "csv":
        # keep_default_na=False keeps a literal cell such as "NA" or an empty string as its text, thus a
        # text cell survives and the row keeps the key.
        return pd.read_csv(path, dtype=str, keep_default_na=False)
    # The host decides the format for both arms. A request with no decided format is a protocol fault, thus
    # the file refuses here and no reader guesses at it.
    raise ValueError("the request names no supported format: " + str(fmt))


def json_rows(path):
    # The host reads a JSON table as an array of flat objects, and it refuses any other shape. Obey the
    # same shape here. An inference pass would turn a shape that the host refuses into a different table.
    with open(path, "rb") as handle:
        value = json.load(handle)
    if not isinstance(value, list):
        raise ValueError("the JSON top-level value is not an array")
    rows = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("a JSON array item is not an object")
        row = {}
        for key, cell in item.items():
            if isinstance(cell, (dict, list)):
                raise ValueError("a JSON cell holds a nested value")
            coerced = coerce_cell(cell)
            if coerced is not None:
                row[str(key)] = coerced
        rows.append(row)
    return rows


def rows_of(frame):
    # A null cell becomes None before the record build, thus a missing cell drops.
    clean = frame.astype(object).where(pd.notnull(frame), None)
    records = clean.to_dict(orient="records")
    rows = []
    for record in records:
        row = {}
        for key, value in record.items():
            cell = coerce_cell(value)
            if cell is not None:
                row[str(key)] = cell
        rows.append(row)
    return rows


def rows_for(path, fmt):
    # The JSON arm reads the strict host shape itself. Each other format reads through pandas.
    if fmt == "json":
        return json_rows(path)
    return rows_of(read_frame(path, fmt))


def main():
    raw = os.environ.get("${EXTRACTION_INPUT_ENV}", "[]")
    requests = json.loads(raw)
    out = {}
    for request in requests:
        path = request["path"]
        fmt = request.get("format")
        expected = request["hash"]
        try:
            # Hash the file before any read. A file that drifted from the pin never reaches the reader, thus
            # the extraction never gives back drifted bytes for the gate to match against.
            actual = sha256_of(path)
            if actual != expected:
                out[path] = {
                    "error": {
                        "type": "hash-mismatch",
                        "message": f"the pinned hash {expected} does not match the on-disk hash {actual}",
                    }
                }
                continue
            out[path] = {"rows": rows_for(path, fmt)}
        except Exception as exc:
            # A per-file read fault lands as a typed error, and the map still holds each other path.
            out[path] = {"error": {"type": "read-fault", "message": str(exc)}}
    json.dump(out, sys.stdout)


main()
`;
