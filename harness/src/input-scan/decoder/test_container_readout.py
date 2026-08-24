from __future__ import annotations

import json
import zipfile

import pytest

from container_readout import (
    HDF5_MAGIC,
    PARQUET_MAGIC,
    clip,
    describe,
    docx_fields,
    hdf5_fields,
    main,
    parquet_fields,
    pdf_fields,
    reader_for,
    render,
)

APP_XML = b"""<?xml version="1.0"?>
<Properties><Pages>7</Pages><Words>1234</Words></Properties>
"""


def write_docx(path, *, properties: bool = True) -> str:
    target = str(path)
    with zipfile.ZipFile(target, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "<document/>")
        if properties:
            archive.writestr("docProps/app.xml", APP_XML)
    return target


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("table.parquet", parquet_fields),
        ("table.PQ", parquet_fields),
        ("matrix.h5", hdf5_fields),
        ("cells.h5ad", hdf5_fields),
        ("cells.loom", hdf5_fields),
        ("legacy.hdf5", hdf5_fields),
        ("protocol.pdf", pdf_fields),
        ("protocol.docx", docx_fields),
    ],
)
def test_reader_dispatch_by_extension(name, expected):
    assert reader_for(name, b"") is expected


def test_reader_dispatch_by_magic():
    assert reader_for("opaque.bin", PARQUET_MAGIC) is parquet_fields
    assert reader_for("opaque.bin", HDF5_MAGIC) is hdf5_fields


def test_reader_declines_what_a_prefix_can_read():
    assert reader_for("counts.csv", b"gene,sample\n") is None
    assert reader_for("calls.vcf.gz", b"\x1f\x8b\x08\x00") is None


def test_docx_fields_reads_app_properties(tmp_path):
    fields = docx_fields(write_docx(tmp_path / "protocol.docx"))
    assert fields == {"parts": 3, "pages": 7, "words": 1234}


def test_docx_fields_without_app_properties(tmp_path):
    fields = docx_fields(write_docx(tmp_path / "bare.docx", properties=False))
    assert fields == {"parts": 2}


def test_docx_fields_on_a_non_zip(tmp_path):
    path = tmp_path / "broken.docx"
    path.write_bytes(b"this is not a zip archive")
    assert "docx read failed" in docx_fields(str(path))["unavailable"]


def test_describe_declines_a_prefix_readable_file(tmp_path):
    path = tmp_path / "counts.csv"
    path.write_text("gene,sample\nTP53,4\n")
    assert describe(str(path)) == {"unavailable": "not a container this decoder reads"}


def test_describe_routes_a_truncated_parquet_to_its_reader(tmp_path):
    path = tmp_path / "table.parquet"
    path.write_bytes(PARQUET_MAGIC)
    assert "unavailable" in describe(str(path))


def test_hdf5_fields_reports_root_keys_and_shapes(tmp_path):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "cells.h5ad"
    with h5py.File(str(path), "w") as handle:
        handle.create_dataset("X", data=[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
        handle.create_dataset("obs", data=[1, 2])
    fields = hdf5_fields(str(path))
    assert fields["rootKeyCount"] == 2
    assert fields["rootKeys"] == "X, obs"
    assert fields["XShape"] == "2x3"
    assert fields["obsShape"] == "2"


def test_hdf5_fields_on_a_file_that_is_not_hdf5(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "fake.h5"
    path.write_bytes(b"not an hdf5 container")
    assert "hdf5 read failed" in hdf5_fields(str(path))["unavailable"]


def test_pdf_fields_refuses_an_oversized_document(tmp_path, monkeypatch):
    path = tmp_path / "huge.pdf"
    path.write_bytes(b"%PDF-1.7\n")
    monkeypatch.setattr("container_readout.DOCUMENT_BYTE_CAP", 1)
    assert pdf_fields(str(path)) == {"unavailable": "document larger than the readout's byte cap"}


def test_render_puts_the_note_on_its_own_key(tmp_path):
    path = tmp_path / "notes.txt"
    path.write_text("plain text")
    record = json.loads(render(str(path)))
    assert record == {"path": str(path), "fields": {}, "unavailable": "not a container this decoder reads"}


def test_render_emits_fields_when_the_container_reads(tmp_path):
    target = write_docx(tmp_path / "protocol.docx")
    record = json.loads(render(target))
    assert record["path"] == target
    assert record["fields"]["pages"] == 7
    assert "unavailable" not in record


def test_render_reports_a_missing_path_rather_than_raising(tmp_path):
    record = json.loads(render(str(tmp_path / "absent.parquet")))
    assert record["fields"] == {}
    assert "FileNotFoundError" in record["unavailable"]


def test_main_writes_one_line_per_path(tmp_path, capsys):
    first = write_docx(tmp_path / "one.docx")
    second = tmp_path / "two.txt"
    second.write_text("plain")
    assert main([first, str(second)]) == 0
    lines = capsys.readouterr().out.strip().split("\n")
    assert [json.loads(line)["path"] for line in lines] == [first, str(second)]


def test_clip_collapses_whitespace_and_bounds_length():
    assert clip("  a\n\tb   c  ") == "a b c"
    assert clip("x" * 500) == "x" * 200
    assert clip("abcdef", 3) == "abc"
