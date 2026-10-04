// The SPDX expression check of the SBOM license gate, for the build script and for the conformance suite.
//
// The check lives in a module of its own, because the build script runs its whole body at import, thus a test
// cannot import from it. The same check exists in Python, in images/sbom/sbom_common.py, because the image
// writers run in the system python3 of an image with no third-party module, and the cli shares no code with
// images/. The two copies read one fixture in their own suites (__fixtures__/spdx-expressions.json, spdx.test.ts
// here, and images/sbom/test_sbom_common.py there), thus a change to one copy that the other does not get
// fails a suite.

/**
 * The SPDX ids that an expression can name: the KNOWN_SPDX set of images/sbom/sbom_common.py. A value outside the
 * set is not an error: it stays a declared name, and the license text of the package goes beside it.
 */
export const KNOWN_SPDX: ReadonlySet<string> = new Set(
    `0BSD AFL-2.1 AFL-3.0 AGPL-3.0 AGPL-3.0-only AGPL-3.0-or-later Apache-1.1 Apache-2.0 Artistic-1.0
    Artistic-1.0-Perl Artistic-2.0 BlueOak-1.0.0 BSD-1-Clause BSD-2-Clause BSD-3-Clause BSD-3-Clause-Clear
    BSD-4-Clause BSL-1.0 bzip2-1.0.6 CC-BY-3.0 CC-BY-4.0 CC-BY-SA-3.0 CC-BY-SA-4.0 CC0-1.0 CDDL-1.0 CDDL-1.1
    CPL-1.0 ECL-2.0 EPL-1.0 EPL-2.0 EUPL-1.1 EUPL-1.2 GFDL-1.3-only GPL-1.0-or-later GPL-2.0 GPL-2.0-only
    GPL-2.0-or-later GPL-3.0 GPL-3.0-only GPL-3.0-or-later HPND ISC LGPL-2.0-only LGPL-2.0-or-later LGPL-2.1
    LGPL-2.1-only LGPL-2.1-or-later LGPL-3.0 LGPL-3.0-only LGPL-3.0-or-later LPL-1.02 MIT MIT-0 MIT-CMU MPL-1.1
    MPL-2.0 MS-PL NCSA ODbL-1.0 OFL-1.1 OpenSSL PostgreSQL PSF-2.0 Python-2.0 Unicode-3.0 Unicode-DFS-2016
    Unlicense UPL-1.0 Vim W3C WTFPL X11 Zlib ZPL-2.1`.split(/\s+/),
);

/** The SPDX exceptions that an expression can name after WITH, the same set as images/sbom/sbom_common.py. */
export const KNOWN_SPDX_EXCEPTIONS: ReadonlySet<string> = new Set([
    "LLVM-exception",
    "Classpath-exception-2.0",
    "GCC-exception-3.1",
    "Autoconf-exception-3.0",
    "Bison-exception-2.2",
]);

/**
 * True when a value is an SPDX expression of known ids that obeys the grammar, the same check as `spdx_valid` in
 * images/sbom/sbom_common.py. An expression is a term, then each AND or OR with a next term. A term is an
 * expression in parentheses, or a known id with an optional `+` and an optional `WITH <exception>`. npm only
 * warns on a license value outside SPDX, thus a published package can declare `UNKNOWN` or `BSD`, and neither
 * one passes here.
 */
export function spdxValid(value: string): boolean {
    const tokens = value
        .replace(/\(/g, " ( ")
        .replace(/\)/g, " ) ")
        .trim()
        .split(/\s+/)
        .filter((token) => token !== "");
    let position = 0;
    function term(): boolean {
        const token = tokens[position];
        if (token === undefined) return false;
        if (token === "(") {
            position += 1;
            if (!expression() || tokens[position] !== ")") return false;
            position += 1;
            return true;
        }
        if (!KNOWN_SPDX.has(token.replace(/\+$/, ""))) return false;
        position += 1;
        if (tokens[position] === "WITH") {
            const exception = tokens[position + 1];
            if (exception === undefined || !KNOWN_SPDX_EXCEPTIONS.has(exception)) return false;
            position += 2;
        }
        return true;
    }
    function expression(): boolean {
        if (!term()) return false;
        while (tokens[position] === "AND" || tokens[position] === "OR") {
            position += 1;
            if (!term()) return false;
        }
        return true;
    }
    return tokens.length > 0 && expression() && position === tokens.length;
}
