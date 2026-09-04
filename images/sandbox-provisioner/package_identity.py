#!/usr/bin/env python3
"""The identity of a package, the query that asks for one, and the grammar
between the two.

This module is the Python twin of `harness/src/sandbox/package-identity.ts`.
One conformance fixture, `harness/src/sandbox/__fixtures__/package-identity.json`,
binds the two: a case that one twin answers differently fails its own suite.

A `PackageQuery` is what a person or an agent asked: a spelling, an optional
track, an optional version. A `PackageIdentity` is the name that an ecosystem
recognizes. The name of a Python identity is the PEP 503 fold of the spelling,
because PEP 503 defines the equivalence of a distribution name. The name of an
R identity is the DESCRIPTION spelling, verbatim, because `library()` is
case-sensitive.

The module imports neither provision.py nor emit_deps.py. Both of those import
this one, thus the fold lives here once and no import cycle forces a second
copy.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# The two ecosystems that the pool holds.
TRACKS = ("python", "r")

# A path, a URL, or a store directory. A location is an installer detail, and
# the pool resolves names.
_LOCATION = re.compile(r"^[.~]|[/\\]|://")

# The `<word>:` prefix of an entry. The group holds the word before the colon.
_PREFIX = re.compile(r"^([A-Za-z][A-Za-z0-9_.-]*):")

# A run of specifier characters. Only the exact run `==` names a version.
_SPECIFIER = re.compile(r"[<>!~=]+")

# A run of characters that an exact version cannot hold: a specifier
# character, a comma, or whitespace. `_SPECIFIER` reads the FIRST run only,
# thus `numpy==1.26,<2` gives the version `1.26,<2` without this guard, and the
# compound range then rides into the pool as a version string.
_VERSION_INTRUDER = re.compile(r"[<>!~=,\s]+")


@dataclass(frozen=True)
class PackageIdentity:
    """The name that one ecosystem recognizes, under the track that holds it.

    Make one with `python_identity`, `r_identity`, or `identity_of`. Each of
    those applies the rule of its track, thus a name that reaches this class
    obeyed a rule.
    """
    track: str
    name: str


@dataclass(frozen=True)
class PackageQuery:
    """What a person or an agent asked for.

    `spelling` is the name verbatim, because a remedy quotes it and an R name
    is case-sensitive. `track` names one ecosystem, and None searches both.
    `version` pins one exact version.
    """
    spelling: str
    track: str | None = None
    version: str | None = None


class QueryError(Exception):
    """An entry that is not a query.

    `type` is one of `empty`, `location`, `unknown_prefix`, and
    `unsupported_specifier`. `prefix` rides with an unknown prefix, and
    `specifier` rides with an unsupported specifier.
    """

    def __init__(self, type: str, entry: str, prefix: str | None = None,
                 specifier: str | None = None):
        super().__init__(f"{type}: {entry!r}")
        self.type = type
        self.entry = entry
        self.prefix = prefix
        self.specifier = specifier


def _fold(name: str) -> str:
    """The PEP 503 fold: each run of `-`, `_`, and `.` becomes one `-`, and the
    case lowers. This is the ONE Python home of the rule. The fold is
    idempotent, thus a fold of a folded name gives that name again."""
    return re.sub(r"[-_.]+", "-", name).lower()


def python_identity(spelling: str) -> PackageIdentity:
    """The Python identity of a spelling. The name folds, because PEP 503 makes
    `PyYAML`, `pyyaml`, and `py_yaml` one distribution."""
    return PackageIdentity("python", _fold(spelling))


def r_identity(name: str) -> PackageIdentity:
    """The R identity of a name. The name keeps its spelling, because
    `library()` is case-sensitive and `GO.db` loads under that exact name."""
    return PackageIdentity("r", name)


def identity_of(track: str, name: str) -> PackageIdentity:
    """The identity of a name that an emitter already minted. The dispatch is
    safe over such a name, because the fold is idempotent."""
    if track == "python":
        return python_identity(name)
    if track == "r":
        return r_identity(name)
    raise ValueError(f"unknown track {track!r}; the tracks are {TRACKS}")


def key(identity: PackageIdentity) -> str:
    """The key of an identity: `<track>:<name>`. Two identities are equal when
    their keys are equal."""
    return f"{identity.track}:{identity.name}"


def parse_identity_key(key_text: str) -> PackageIdentity | None:
    """The identity that a key names, or None when the string is not a key.

    The FIRST colon splits the two halves. A track name holds no colon, and
    neither a PEP 503 name nor an R name can hold one, thus `r:GO.db` gives the
    R identity `GO.db`, dot and all. The name rides through `identity_of`, and
    the fold is idempotent, thus a key that `key` wrote comes back as the
    identity that wrote it.
    """
    at = key_text.find(":")
    if at < 0:
        return None
    track = key_text[:at]
    name = key_text[at + 1:]
    if not name or track not in TRACKS:
        return None
    return identity_of(track, name)


def address(identity: PackageIdentity) -> str:
    """The store address of an identity: the PEP 503 fold of its name, for both
    tracks.

    A store directory is an address and not an identity, thus two identities
    can share one address: `r:decoupleR` and `python:decoupler` both address as
    `decoupler`. The pin marker inside the directory carries the identity.
    """
    return _fold(identity.name)


def parse_query(entry: str) -> PackageQuery:
    """Read one entry of the grammar `[python:|r:]<spelling>[==<version>]`.

    The entry trims once, and the parts keep what the trim left. An entry that
    is not a query raises `QueryError`.
    """
    trimmed = entry.strip()
    if not trimmed:
        raise QueryError("empty", trimmed)
    if _LOCATION.search(trimmed):
        raise QueryError("location", trimmed)

    prefix = _PREFIX.match(trimmed)
    word = prefix.group(1) if prefix else None
    if word is not None and word not in TRACKS:
        raise QueryError("unknown_prefix", trimmed, prefix=word)
    track = word
    rest = trimmed if track is None else trimmed[len(track) + 1:]
    if not rest:
        raise QueryError("empty", trimmed)

    specifier = _SPECIFIER.search(rest)
    if specifier is None:
        return PackageQuery(rest, track, None)
    if specifier.group(0) != "==":
        raise QueryError("unsupported_specifier", trimmed,
                         specifier=specifier.group(0))
    # Both halves strip: `numpy == 1.26.4` is one ask, and an unstripped half
    # makes the spelling `numpy ` and the version ` 1.26.4`, neither of which
    # any index holds.
    spelling = rest[:specifier.start()].strip()
    if not spelling:
        raise QueryError("empty", trimmed)
    # `name==` names no version, thus the query pins none and the pool answers
    # the newest. The round-trip law holds, because `format_query` writes the
    # specifier only beside a version.
    version = rest[specifier.start() + 2:].strip()
    intruder = _VERSION_INTRUDER.search(version)
    if intruder is not None:
        raise QueryError("unsupported_specifier", trimmed,
                         specifier=intruder.group(0))
    return PackageQuery(spelling, track, version or None)


def format_query(query: PackageQuery) -> str:
    """Write a query in the grammar. The prefix rides only beside a track, and
    `==<version>` only beside a version. For every query,
    `parse_query(format_query(query))` gives that query again."""
    prefix = "" if query.track is None else f"{query.track}:"
    version = "" if query.version is None else f"=={query.version}"
    return f"{prefix}{query.spelling}{version}"
