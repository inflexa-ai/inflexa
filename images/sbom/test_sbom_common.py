#!/usr/bin/env python3
"""The conformance suite of the Python copy of the SPDX expression check.

The suite reads one fixture, which the TypeScript copy (cli/src/modules/sbom/spdx.ts)
also reads in cli/src/modules/sbom/spdx.test.ts. A case that one copy answers
differently fails its own suite, thus the two copies cannot drift in silence.

The fixture lives in the repository, beside the TypeScript copy, and not in an
image. Outside a checkout the file is absent, and the suite then skips with
that reason. In CI a missing fixture fails the run instead. The suite uses the
standard library only, like the module that it tests. Run it with
`python3 -m unittest discover -s images/sbom`.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

import sbom_common

# The one fixture, beside the TypeScript copy. The path is relative to this
# file, thus the suite finds it from any working directory.
FIXTURE = (Path(__file__).resolve().parent
           / ".." / ".." / "cli" / "src" / "modules" / "sbom" / "__fixtures__"
           / "spdx-expressions.json")

SKIP_REASON = (f"the conformance fixture {FIXTURE.name} is not at {FIXTURE}; "
               "it lives in the repository, not in an image")


def _fixture() -> dict | None:
    try:
        return json.loads(FIXTURE.read_text())
    except (OSError, ValueError):
        return None


CASES = _fixture()

# Outside a checkout the suite skips, but CI always has the checkout. There a
# skip would switch the drift check off in silence, thus a missing fixture
# fails the run.
if CASES is None and os.environ.get("CI") == "true":
    raise RuntimeError(SKIP_REASON)


@unittest.skipIf(CASES is None, SKIP_REASON)
class ConformanceFixtureTests(unittest.TestCase):
    """The sets and each case of the fixture, asserted against the Python copy."""

    def test_the_known_ids_are_the_ids_of_the_fixture(self):
        self.assertEqual(sorted(sbom_common.KNOWN_SPDX), sorted(CASES["known_ids"]))

    def test_the_known_exceptions_are_the_exceptions_of_the_fixture(self):
        self.assertEqual(sorted(sbom_common.KNOWN_SPDX_EXCEPTIONS),
                         sorted(CASES["known_exceptions"]))

    def test_each_case_gets_its_answer(self):
        for case in CASES["cases"]:
            with self.subTest(value=case["value"], note=case["note"]):
                self.assertEqual(sbom_common.spdx_valid(case["value"]), case["valid"])

    def test_each_known_id_is_a_valid_expression_alone(self):
        for spdx_id in CASES["known_ids"]:
            with self.subTest(spdx_id=spdx_id):
                self.assertTrue(sbom_common.spdx_valid(spdx_id))


if __name__ == "__main__":
    unittest.main()
