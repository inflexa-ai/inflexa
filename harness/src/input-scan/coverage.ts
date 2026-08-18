/**
 * Profile coverage — how much of the scanned tree the agent's kinds actually describe.
 *
 * Measured against the SUBMITTED kinds, never against the scan's own shapes. Computed
 * from the shapes it would report only whether the scan grouped its own observations,
 * which is always yes; measured against the kinds it is a real check, and it is the
 * check that was missing when a profile covering 49 of 3513 files read as complete and
 * fresh.
 *
 * Deterministic by construction: matching declared patterns against a known file set
 * requires no judgement, and a coverage figure a model self-reported would not be a
 * check at all.
 */

/** Unmatched paths carried on the snapshot, so a shortfall names examples rather than a bare count. */
const MAX_UNMATCHED_SAMPLE = 10;

export interface ProfileCoverage {
    /** Files matching at least one declared kind pattern. */
    readonly matched: number;
    readonly unmatched: number;
    readonly total: number;
    readonly unmatchedSample: string[];
}

/**
 * Compile a kind's path pattern to a matcher.
 *
 * `**` crosses directory separators, `*` and `?` do not, and `<0>`-style placeholders —
 * the syntax the manifest renders variable positions in, which an agent may reasonably
 * copy — match one token. Everything else is literal.
 */
function compilePattern(pattern: string): RegExp {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i]!;
        if (char === "*") {
            if (pattern[i + 1] === "*") {
                out += ".*";
                i++;
                // `**/` should also match zero directories, so the slash is optional.
                if (pattern[i + 1] === "/") i++;
                continue;
            }
            out += "[^/]*";
            continue;
        }
        if (char === "?") {
            out += "[^/]";
            continue;
        }
        if (char === "<") {
            const close = pattern.indexOf(">", i);
            if (close > i) {
                out += "[^/]*";
                i = close;
                continue;
            }
        }
        out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${out}$`);
}

function normalize(path: string): string {
    return path.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+/g, "/");
}

/**
 * Whether a path falls under a pattern. A pattern naming a directory covers everything
 * beneath it — agents write `data/inputs/vcf` as often as `data/inputs/vcf/*.vcf.gz`,
 * and reading the first as a zero-file kind would report a coverage failure that is an
 * artefact of notation.
 */
function matches(path: string, pattern: string, compiled: RegExp): boolean {
    if (compiled.test(path)) return true;
    const bare = pattern.replace(/\/+$/, "");
    return bare.length > 0 && !/[*?<]/.test(bare) && path.startsWith(`${bare}/`);
}

/** Coverage of a scanned file set by a set of declared kind patterns. */
export function computeCoverage(paths: readonly string[], patterns: readonly string[]): ProfileCoverage {
    const compiled = patterns.map((pattern) => ({ pattern, regex: compilePattern(pattern) }));
    const unmatchedSample: string[] = [];
    let matched = 0;

    for (const raw of paths) {
        const path = normalize(raw);
        if (compiled.some(({ pattern, regex }) => matches(path, pattern, regex))) {
            matched++;
            continue;
        }
        if (unmatchedSample.length < MAX_UNMATCHED_SAMPLE) unmatchedSample.push(path);
    }

    return { matched, unmatched: paths.length - matched, total: paths.length, unmatchedSample };
}
