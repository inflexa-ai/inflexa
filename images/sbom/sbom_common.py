"""The shared parts of the two SBOM writers: the image SBOM and the store SBOM.

Both writers emit CycloneDX 1.6 JSON, and both obey one license rule: each
component carries a license that a reader can resolve. A resolved license is
an SPDX id, an SPDX expression, a declared license name, or a name with the
license text attached. A text hash, a bare file reference, and an empty field
are not resolved, and the writers fail the build on them.

The module uses the standard library only, because it runs in the system
python3 of the two images, and that python3 has no third-party module.
"""
import hashlib
import json
import re
import uuid
from email.parser import HeaderParser
from pathlib import Path

SPEC_VERSION = "1.6"

SUPPLIER = {"name": "Inflexa", "url": ["https://github.com/inflexa-ai/inflexa"]}

# A license name that names nothing a reader can act on.
UNRESOLVED_NAME = re.compile(
    r"^(sha256:[0-9a-f]+|file\s+licen[cs]e|see\s+licen[cs]e.*|unknown|noassertion|none|other/proprietary license|)$",
    re.IGNORECASE,
)

# The cap on one attached license text. A copyright file larger than this is
# cut, and the cut is marked in the text.
TEXT_LIMIT = 200_000

# The SPDX license ids that the writers accept as an id, and as a term of an
# expression. A declared value outside this set stays a declared name. The
# set holds the ids that the scanned images and the store hold, not the whole
# SPDX list.
KNOWN_SPDX = frozenset("""
0BSD AFL-2.1 AFL-3.0 AGPL-3.0 AGPL-3.0-only AGPL-3.0-or-later Apache-1.1
Apache-2.0 Artistic-1.0 Artistic-1.0-Perl Artistic-2.0 BlueOak-1.0.0
BSD-1-Clause BSD-2-Clause BSD-3-Clause BSD-3-Clause-Clear BSD-4-Clause BSL-1.0
bzip2-1.0.6 CC-BY-3.0 CC-BY-4.0 CC-BY-SA-3.0 CC-BY-SA-4.0 CC0-1.0 CDDL-1.0
CDDL-1.1 CPL-1.0 ECL-2.0 EPL-1.0 EPL-2.0 EUPL-1.1 EUPL-1.2 GFDL-1.3-only
GPL-1.0-or-later GPL-2.0 GPL-2.0-only GPL-2.0-or-later GPL-3.0 GPL-3.0-only
GPL-3.0-or-later HPND ISC LGPL-2.0-only LGPL-2.0-or-later LGPL-2.1
LGPL-2.1-only LGPL-2.1-or-later LGPL-3.0 LGPL-3.0-only LGPL-3.0-or-later
LPL-1.02 MIT MIT-0 MIT-CMU MPL-1.1 MPL-2.0 MS-PL NCSA ODbL-1.0 OFL-1.1 OpenSSL
PostgreSQL PSF-2.0 Python-2.0 Unicode-3.0 Unicode-DFS-2016 Unlicense UPL-1.0
Vim W3C WTFPL X11 Zlib ZPL-2.1
""".split())

# The known ids by their lower case, for a declared value that has the wrong case.
KNOWN_SPDX_FOLDED = {spdx.lower(): spdx for spdx in KNOWN_SPDX}

# The SPDX exceptions that an expression can name after WITH.
KNOWN_SPDX_EXCEPTIONS = frozenset(
    ["LLVM-exception", "Classpath-exception-2.0", "GCC-exception-3.1", "Autoconf-exception-3.0", "Bison-exception-2.2"]
)

# R license specs that map to one SPDX id without doubt. An unversioned
# "GPL" or "LGPL" means "any version", and SPDX has no id for that, thus such
# a spec stays a declared name.
R_SPDX_SPACED = {
    "gpl-2": "GPL-2.0-only",
    "gpl-3": "GPL-3.0-only",
    "gpl (>= 2)": "GPL-2.0-or-later",
    "gpl (>= 2.0)": "GPL-2.0-or-later",
    "gpl (>= 3)": "GPL-3.0-or-later",
    "gpl (>= 3.0)": "GPL-3.0-or-later",
    "gpl (== 2)": "GPL-2.0-only",
    "gpl (== 3)": "GPL-3.0-only",
    "lgpl-2": "LGPL-2.0-only",
    "lgpl-2.1": "LGPL-2.1-only",
    "lgpl-3": "LGPL-3.0-only",
    "lgpl (>= 2)": "LGPL-2.0-or-later",
    "lgpl (>= 2.0)": "LGPL-2.0-or-later",
    "lgpl (>= 2.1)": "LGPL-2.1-or-later",
    "lgpl (>= 3)": "LGPL-3.0-or-later",
    "agpl-3": "AGPL-3.0-only",
    "agpl (>= 3)": "AGPL-3.0-or-later",
    "mit": "MIT",
    "bsd_2_clause": "BSD-2-Clause",
    "bsd_3_clause": "BSD-3-Clause",
    "apache license 2.0": "Apache-2.0",
    "apache license (== 2.0)": "Apache-2.0",
    "apache license (== 2)": "Apache-2.0",
    "apache license version 2.0": "Apache-2.0",
    "artistic-2.0": "Artistic-2.0",
    "cc0": "CC0-1.0",
    "cc by 4.0": "CC-BY-4.0",
    "cc by-sa 4.0": "CC-BY-SA-4.0",
    "mpl-2.0": "MPL-2.0",
    "bsl-1.0": "BSL-1.0",
}

# The lookup key of an R spec drops each space.
R_SPDX = {key.replace(" ", ""): value for key, value in R_SPDX_SPACED.items()}

# The R license that "Part of R x.y.z" names: the license of R itself.
R_ITSELF = "GPL-2.0-only OR GPL-3.0-only"

# Trove classifiers that map to one SPDX id without doubt.
CLASSIFIER_SPDX = {
    "License :: OSI Approved :: MIT License": "MIT",
    "License :: OSI Approved :: MIT No Attribution License (MIT-0)": "MIT-0",
    "License :: OSI Approved :: ISC License (ISCL)": "ISC",
    "License :: OSI Approved :: Apache Software License": None,
    "License :: OSI Approved :: BSD License": None,
    "License :: OSI Approved :: GNU General Public License v2 (GPLv2)": "GPL-2.0-only",
    "License :: OSI Approved :: GNU General Public License v2 or later (GPLv2+)": "GPL-2.0-or-later",
    "License :: OSI Approved :: GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
    "License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
    "License :: OSI Approved :: GNU Lesser General Public License v2 (LGPLv2)": "LGPL-2.0-only",
    "License :: OSI Approved :: GNU Lesser General Public License v2 or later (LGPLv2+)": "LGPL-2.0-or-later",
    "License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
    "License :: OSI Approved :: GNU Lesser General Public License v3 or later (LGPLv3+)": "LGPL-3.0-or-later",
    "License :: OSI Approved :: GNU Affero General Public License v3": "AGPL-3.0-only",
    "License :: OSI Approved :: GNU Affero General Public License v3 or later (AGPLv3+)": "AGPL-3.0-or-later",
    "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "License :: OSI Approved :: Python Software Foundation License": "PSF-2.0",
    "License :: OSI Approved :: The Unlicense (Unlicense)": "Unlicense",
    "License :: OSI Approved :: Zope Public License": None,
    "License :: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication": "CC0-1.0",
}


def spdx_valid(declared: str) -> bool:
    """True when a value is an SPDX expression of known ids that obeys the grammar.

    The grammar: an expression is a term, then each AND or OR with a next
    term. A term is an expression in parentheses, or a known id with an
    optional "+" and an optional "WITH <exception>".
    """
    tokens = declared.replace("(", " ( ").replace(")", " ) ").split()
    position = 0

    def term() -> bool:
        nonlocal position
        if position >= len(tokens):
            return False
        token = tokens[position]
        if token == "(":
            position += 1
            if not expression() or position >= len(tokens) or tokens[position] != ")":
                return False
            position += 1
            return True
        if token.rstrip("+") not in KNOWN_SPDX:
            return False
        position += 1
        if position < len(tokens) and tokens[position] == "WITH":
            position += 1
            if position >= len(tokens) or tokens[position] not in KNOWN_SPDX_EXCEPTIONS:
                return False
            position += 1
        return True

    def expression() -> bool:
        nonlocal position
        if not term():
            return False
        while position < len(tokens) and tokens[position] in ("AND", "OR"):
            position += 1
            if not term():
                return False
        return True

    return bool(tokens) and expression() and position == len(tokens)


def spdx_entry(declared: str) -> dict | None:
    """A license entry when a declared value is one known SPDX id or a valid expression of known ids."""
    declared = declared.strip()
    if declared.lower() in KNOWN_SPDX_FOLDED:
        return {"license": {"id": KNOWN_SPDX_FOLDED[declared.lower()]}}
    if spdx_valid(declared):
        return {"expression": declared}
    return None


def read_text(path: Path) -> str | None:
    """Read a text file, and cut it at TEXT_LIMIT. None when the file is absent."""
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return None
    if len(text) > TEXT_LIMIT:
        text = text[:TEXT_LIMIT] + f"\n[cut at {TEXT_LIMIT} characters]\n"
    return text


def text_license(name: str, text: str) -> dict:
    """A license entry that carries its own text."""
    return {"license": {"name": name, "text": {"contentType": "text/plain", "content": text}}}


def entry_resolved(entry: dict) -> bool:
    """True when one license entry names a license that a reader can resolve."""
    if entry.get("expression"):
        return True
    lic = entry.get("license") or {}
    if lic.get("id"):
        return True
    if "text" in lic:
        # The name of a text entry is a label. The text decides, thus a text
        # that holds only "UNKNOWN" resolves nothing.
        text = ((lic.get("text") or {}).get("content") or "").strip()
        return bool(text) and not UNRESOLVED_NAME.match(text)
    name = (lic.get("name") or "").strip()
    return bool(name) and not UNRESOLVED_NAME.match(name)


def bare_name(entry: dict) -> bool:
    """True when a license entry is a declared name with no SPDX id and no text."""
    lic = entry.get("license") or {}
    return bool(lic.get("name")) and not lic.get("id") and not (lic.get("text") or {}).get("content")


def licenses_resolved(licenses: list | None) -> bool:
    """True when a license list is not empty and each entry in it is resolved."""
    return bool(licenses) and all(entry_resolved(e) for e in licenses)


def r_licenses(field: str | None, package_dir: Path) -> list:
    """The CycloneDX licenses of one R package, from its DESCRIPTION `License` field.

    An alternative that names `file LICENSE` or `file LICENCE` gets the text
    of that file. When each alternative maps to SPDX, the result is one id or
    one expression. Otherwise the declared field stays a name.
    """
    field = " ".join((field or "").split())
    if not field:
        return []
    if field.lower().startswith("part of r"):
        return [{"expression": R_ITSELF}]
    file_text = None
    ids = []
    mapped = True
    for alternative in field.split("|"):
        spec = alternative.strip()
        match = re.match(r"^(.*?)\s*\+?\s*file\s+(licen[cs]e)$", spec, re.IGNORECASE)
        if match:
            spec = match.group(1).strip()
            file_text = file_text or read_text(package_dir / match.group(2))
        if not spec:
            mapped = False
            continue
        spdx = R_SPDX.get(spec.lower().replace(" ", "")) or KNOWN_SPDX_FOLDED.get(spec.lower())
        if spdx is None:
            mapped = False
        else:
            ids.append(spdx)
    if mapped and len(ids) == 1:
        entry = {"license": {"id": ids[0]}}
        if file_text:
            entry["license"]["text"] = {"contentType": "text/plain", "content": file_text}
        return [entry]
    if mapped and ids and not file_text:
        return [{"expression": " OR ".join(ids)}]
    if file_text:
        return [text_license(field, file_text)]
    return [{"license": {"name": field}}]


def parse_metadata(path: Path) -> dict:
    """The header fields of a Python METADATA or PKG-INFO file, or of an R DESCRIPTION file.

    The three formats are RFC 822 headers. A field can repeat, and a folded
    value continues on lines that start with white space. A line of white
    space only is a part of a folded value, for example a blank line of a
    License text, and only an empty line ends the headers. The parser of the
    email module obeys these rules. The lines of a folded value lose their
    indentation.
    """
    message = HeaderParser().parsestr(read_text(path) or "")
    fields: dict[str, list[str]] = {}
    for key, value in message.items():
        lines = [line.strip() for line in str(value).splitlines()]
        fields.setdefault(key.strip().lower(), []).append("\n".join(lines).strip())
    return fields


def license_files(metadata: Path, fields: dict) -> list:
    """The text entries of the license files of one Python distribution."""
    dist_info = metadata.parent
    texts = []
    for name in fields.get("license-file", []):
        for candidate in (dist_info / "licenses" / name, dist_info / name):
            text = read_text(candidate)
            if text:
                texts.append(text_license(f"License text ({name})", text))
                break
    if not texts:
        for candidate in sorted(dist_info.glob("LICEN[CS]E*")) + sorted(dist_info.glob("COPYING*")) + sorted(dist_info.glob("licenses/*")):
            if candidate.is_file():
                text = read_text(candidate)
                if text:
                    texts.append(text_license(f"License text ({candidate.name})", text))
    return texts


def name_like(declared: str) -> bool:
    """True when a declared License field reads as a license name, and not as a part of a license text."""
    return (
        bool(declared)
        and "\n" not in declared
        and len(declared) <= 80
        and not declared.startswith(("#", "Copyright", "Files:"))
        and not UNRESOLVED_NAME.match(declared)
    )


def python_licenses(metadata: Path) -> list:
    """The CycloneDX licenses of one Python distribution, from its METADATA.

    The order of trust: the `License-Expression` field, a `License` field
    that is SPDX, the license classifiers, a `License` field that reads as a
    name, then the text of the license files. A declared name that is not
    SPDX gets the license file text when the distribution carries one.
    """
    fields = parse_metadata(metadata)
    expression = (fields.get("license-expression") or [""])[0]
    if expression:
        return [{"expression": expression}]
    declared = (fields.get("license") or [""])[0].strip()
    found = spdx_entry(declared) if declared else None
    if found:
        return [found]
    texts = license_files(metadata, fields)
    entries = []
    for classifier in fields.get("classifier", []):
        if not classifier.startswith("License ::"):
            continue
        spdx = CLASSIFIER_SPDX.get(classifier)
        name = classifier.split("::")[-1].strip()
        if spdx:
            entries.append({"license": {"id": spdx}})
        elif name and name != "OSI Approved":
            entries.append({"license": {"name": name}})
    if not entries and name_like(declared):
        entries.append({"license": {"name": declared}})
    if entries:
        if texts and not any(entry["license"].get("id") for entry in entries):
            entries[0]["license"]["text"] = texts[0]["license"]["text"]
        return entries
    if texts:
        return texts
    if declared and not UNRESOLVED_NAME.match(declared):
        return [text_license("License text (METADATA License field)", declared)]
    return []


def purl_qualifiers(qualifiers: dict) -> str:
    """The qualifier part of a purl: sorted keys, percent-encoded values, empty values left out."""
    from urllib.parse import quote

    parts = [f"{key}={quote(str(value), safe='')}" for key, value in sorted(qualifiers.items()) if value]
    return ("?" + "&".join(parts)) if parts else ""


def deterministic_serial(document: dict) -> str:
    """A serial number that the content of the document decides.

    The same content gives the same serial, thus a rebuild of the same content
    gives the same bytes.
    """
    body = dict(document)
    body.pop("serialNumber", None)
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).digest()
    return f"urn:uuid:{uuid.UUID(bytes=digest[:16], version=5)}"


def write_document(document: dict, out: Path) -> None:
    """Write a document as compact, key-sorted JSON with a final newline."""
    out.write_text(json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False) + "\n")
