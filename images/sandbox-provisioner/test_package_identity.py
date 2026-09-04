#!/usr/bin/env python3
"""The conformance suite of the Python twin.

The suite reads one fixture, which the TypeScript twin also reads. A case that
one twin answers differently fails its own suite, thus the two copies of the
grammar cannot drift in silence.

The fixture lives in the repository and not in the provisioner image. Outside a
checkout the file is absent, and the suite then skips with that reason.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import package_identity
from package_identity import (
    QueryError,
    address,
    format_query,
    identity_of,
    key,
    parse_query,
    python_identity,
    r_identity,
)

# The one fixture, beside the TypeScript twin. The path is relative to this
# file, thus the suite finds it from any working directory.
FIXTURE = (Path(__file__).resolve().parent
           / ".." / ".." / "harness" / "src" / "sandbox" / "__fixtures__"
           / "package-identity.json")

SKIP_REASON = (f"the conformance fixture {FIXTURE.name} is not at {FIXTURE}; "
               "it lives in the repository, not in the provisioner image")


def _fixture() -> dict | None:
    try:
        return json.loads(FIXTURE.read_text())
    except (OSError, ValueError):
        return None


CASES = _fixture()


@unittest.skipIf(CASES is None, SKIP_REASON)
class ConformanceFixtureTests(unittest.TestCase):
    """Each case of the fixture, asserted against the Python twin."""

    def test_each_parse_case(self):
        for case in CASES["parse"]:
            with self.subTest(entry=case["entry"]):
                if "error" in case:
                    with self.assertRaises(QueryError) as caught:
                        parse_query(case["entry"])
                    self.assertEqual(caught.exception.type, case["error"])
                    if "prefix" in case:
                        self.assertEqual(caught.exception.prefix, case["prefix"])
                    if "specifier" in case:
                        self.assertEqual(caught.exception.specifier,
                                         case["specifier"])
                    continue
                query = parse_query(case["entry"])
                expected = case["query"]
                self.assertEqual(query.spelling, expected["spelling"])
                self.assertEqual(query.track, expected.get("track"))
                self.assertEqual(query.version, expected.get("version"))

    def test_each_identity_case(self):
        for case in CASES["identity"]:
            with self.subTest(track=case["track"], input=case["input"]):
                identity = identity_of(case["track"], case["input"])
                self.assertEqual(identity.name, case["name"])
                self.assertEqual(key(identity), case["key"])
                self.assertEqual(address(identity), case["address"])

    def test_each_round_trip_case(self):
        for case in CASES["round_trip"]:
            with self.subTest(formatted=case["formatted"]):
                raw = case["query"]
                query = package_identity.PackageQuery(
                    raw["spelling"], raw.get("track"), raw.get("version"))
                self.assertEqual(format_query(query), case["formatted"])
                self.assertEqual(parse_query(case["formatted"]), query)


class TwinIndependenceTests(unittest.TestCase):
    """The twin stands alone, and the two constructors keep their rules."""

    def test_the_twin_imports_no_caller(self):
        # An import of a caller would make the cycle that forced a second copy
        # of the fold.
        source = (Path(__file__).resolve().parent / "package_identity.py").read_text()
        self.assertNotIn("import provision", source)
        self.assertNotIn("import emit_deps", source)

    def test_the_two_constructors_keep_their_rules(self):
        self.assertEqual(python_identity("PyYAML").name, "pyyaml")
        self.assertEqual(r_identity("decoupleR").name, "decoupleR")
        self.assertEqual(address(r_identity("GO.db")), "go-db")

    def test_a_dispatch_over_an_emitted_name_is_stable(self):
        self.assertEqual(identity_of("python", "pyyaml"), python_identity("PyYAML"))


if __name__ == "__main__":
    unittest.main()
