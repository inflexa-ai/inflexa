"""Header readouts a bounded file prefix cannot produce.

Parquet keeps its schema in a footer, the HDF5 families spread object structure
across the file, and PDF and DOCX both index their contents from a trailer.
Reading any of them means parsing the whole container, which is the exposure the
sandbox exists to contain; every other readout the input scan needs is
prefix-sufficient and runs in the harness process.

Reads one path per argument and writes one JSON object per line to stdout:
``{"path": ..., "fields": {...}}``, plus an ``"unavailable"`` key when the
container could not be read.
"""

from __future__ import annotations

import json
import os
import re
import sys
import zipfile

PARQUET_MAGIC = b"PAR1"
HDF5_MAGIC = b"\x89HDF\r\n\x1a\n"

PARQUET_SUFFIXES = (".parquet", ".pq")
HDF5_SUFFIXES = (".h5", ".hdf5", ".h5ad", ".loom")

MAX_FIELD_CHARS = 200
MAX_NAME_CHARS = 24
MAX_NAMES_REPORTED = 12
MAX_ROOT_KEYS = 20
MAX_REASON_CHARS = 80

# A trailer-indexed document is read whole; past this it is not read at all.
DOCUMENT_BYTE_CAP = 33_554_432

HDF5_PROBES = ("X", "obs", "var", "matrix", "layers")


def clip(text: str, limit: int = MAX_FIELD_CHARS) -> str:
    return " ".join(str(text).split())[:limit]


def join_names(names: list) -> str:
    return clip(", ".join(str(name)[:MAX_NAME_CHARS] for name in names[:MAX_NAMES_REPORTED]))


def parquet_fields(path: str) -> dict:
    try:
        import pyarrow.parquet as pq
    except ImportError:
        return {"unavailable": "pyarrow is not installed in this sandbox"}
    try:
        handle = pq.ParquetFile(path)
        schema = handle.schema_arrow
        return {
            "columnCount": len(schema.names),
            "columns": join_names(list(schema.names)),
            "columnTypes": join_names([field.type for field in schema]),
            "rowCount": handle.metadata.num_rows,
            "rowGroups": handle.metadata.num_row_groups,
        }
    except (OSError, ValueError) as exc:
        return {"unavailable": "parquet read failed: " + clip(str(exc), MAX_REASON_CHARS)}


def hdf5_fields(path: str) -> dict:
    try:
        import h5py
    except ImportError:
        return {"unavailable": "h5py is not installed in this sandbox"}
    try:
        with h5py.File(path, "r") as handle:
            keys = list(handle.keys())
            fields = {"rootKeys": join_names(keys[:MAX_ROOT_KEYS]), "rootKeyCount": len(keys)}
            for probe in HDF5_PROBES:
                shape = getattr(handle.get(probe), "shape", None)
                if shape:
                    fields[probe + "Shape"] = "x".join(str(extent) for extent in shape)
            return fields
    except (OSError, RuntimeError, ValueError) as exc:
        return {"unavailable": "hdf5 read failed: " + clip(str(exc), MAX_REASON_CHARS)}


def pdf_fields(path: str) -> dict:
    if os.path.getsize(path) > DOCUMENT_BYTE_CAP:
        return {"unavailable": "document larger than the readout's byte cap"}
    try:
        from pypdf import PdfReader
    except ImportError:
        return {"unavailable": "pypdf is not installed in this sandbox"}
    try:
        pages = PdfReader(path).pages
        text = pages[0].extract_text() or "" if len(pages) else ""
        return {"pageCount": len(pages), "firstPageText": clip(text)}
    except Exception as exc:
        return {"unavailable": "pdf read failed: " + clip(str(exc), MAX_REASON_CHARS)}


def docx_fields(path: str) -> dict:
    if os.path.getsize(path) > DOCUMENT_BYTE_CAP:
        return {"unavailable": "document larger than the readout's byte cap"}
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            fields = {"parts": len(names)}
            if "docProps/app.xml" in names:
                properties = archive.read("docProps/app.xml").decode("utf8", "replace")
                for tag in ("Pages", "Words"):
                    match = re.search(f"<{tag}>(\\d+)</{tag}>", properties)
                    if match:
                        fields[tag.lower()] = int(match.group(1))
            return fields
    except (OSError, zipfile.BadZipFile) as exc:
        return {"unavailable": "docx read failed: " + clip(str(exc), MAX_REASON_CHARS)}


def reader_for(path: str, magic: bytes):
    """The reader a path belongs to, by extension first and container magic second."""
    lowered = path.lower()
    if lowered.endswith(PARQUET_SUFFIXES) or magic.startswith(PARQUET_MAGIC):
        return parquet_fields
    if lowered.endswith(HDF5_SUFFIXES) or magic.startswith(HDF5_MAGIC):
        return hdf5_fields
    if lowered.endswith(".pdf"):
        return pdf_fields
    if lowered.endswith(".docx"):
        return docx_fields
    return None


def describe(path: str) -> dict:
    with open(path, "rb") as handle:
        magic = handle.read(len(HDF5_MAGIC))
    reader = reader_for(path, magic)
    if reader is None:
        return {"unavailable": "not a container this decoder reads"}
    return reader(path)


def render(path: str) -> str:
    try:
        fields = describe(path)
    except OSError as exc:
        fields = {"unavailable": type(exc).__name__ + ": " + clip(str(exc), MAX_REASON_CHARS)}
    note = fields.pop("unavailable", None)
    record = {"path": path, "fields": fields}
    if note:
        record["unavailable"] = note
    return json.dumps(record)


def main(paths: list) -> int:
    for path in paths:
        sys.stdout.write(render(path) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
