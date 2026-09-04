/**
 * The identity of a package, the query that asks for one, and the resolution
 * between the two.
 *
 * A package name crosses the harness, the embedder, and the provisioner. As a
 * bare `string` each site applies the rule that it believes, and two sites then
 * disagree on whether `decoupleR` and `decoupler` are one package. This module
 * is the one place that knows the rule.
 *
 * Two types carry the two ideas. A {@link PackageQuery} is what a person or an
 * agent asked: a spelling, an optional track, an optional version. A
 * {@link PackageIdentity} is the name that an ecosystem recognizes. The
 * identity is opaque, thus a caller cannot invent one, and every identity comes
 * from {@link pythonIdentity}, {@link rIdentity}, or {@link identityOf}.
 *
 * The PEP 503 fold lives in exactly one function of this file. The provisioner
 * holds the Python twin, `images/sandbox-provisioner/package_identity.py`, and
 * one fixture binds the two.
 */

import { err, ok, type Result } from "neverthrow";

/** The two ecosystems that the pool holds. */
export type Track = "python" | "r";

/**
 * What a person or an agent asked for. `spelling` is the name verbatim, as the
 * caller wrote it — a remedy quotes it, and an R name is case-sensitive at
 * `library()`. `track` names one ecosystem, and its absence searches both.
 * `version` pins one exact version.
 *
 * A query is never a key. Two queries of one fold are two asks, because a
 * caller that wrote `decoupleR` did not ask for `decoupler`.
 */
export type PackageQuery = {
    readonly spelling: string;
    readonly track?: Track;
    readonly version?: string;
};

/**
 * The brand of an identity name. It has no runtime value: it exists so that a
 * literal `{ track, name }` fails the typecheck outside this module, and thus
 * every identity comes from a constructor that applied the rule of its track.
 */
declare const identityBrand: unique symbol;

/**
 * The name that one ecosystem recognizes, under the track that holds it.
 *
 * The name of a Python identity is the PEP 503 fold of the spelling, because
 * PEP 503 defines the equivalence of a distribution name. The name of an R
 * identity is the DESCRIPTION spelling, verbatim, because `library()` is
 * case-sensitive. Two identities are equal when their keys are equal.
 */
export type PackageIdentity = {
    readonly track: Track;
    readonly name: string & { readonly [identityBrand]: true };
};

/**
 * The PEP 503 fold: each run of `-`, `_`, and `.` becomes one `-`, and the
 * case lowers. This is the ONE TypeScript home of the rule. The fold is
 * idempotent, thus a fold of a folded name gives that name again.
 */
function fold(name: string): string {
    return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/**
 * Brand a name that a constructor of this module already ruled on.
 *
 * The cast is the whole point of the brand: the brand has no runtime value,
 * thus only a cast can produce one, and this function is the one place that
 * casts. A caller outside the module reaches a name through a constructor.
 */
function brand(name: string): PackageIdentity["name"] {
    // The brand is a compile-time marker with no runtime value, thus a cast is
    // the only way to mint one, and this function is the only site that casts.
    return name as PackageIdentity["name"];
}

/**
 * The Python identity of a spelling. The name folds, because PEP 503 makes
 * `PyYAML`, `pyyaml`, and `py_yaml` one distribution.
 *
 * @param spelling The distribution name, as the caller spells it.
 */
export function pythonIdentity(spelling: string): PackageIdentity {
    return { track: "python", name: brand(fold(spelling)) };
}

/**
 * The R identity of a name. The name keeps its spelling, because `library()`
 * is case-sensitive and `GO.db` loads under that exact name.
 *
 * @param name The DESCRIPTION `Package` value.
 */
export function rIdentity(name: string): PackageIdentity {
    return { track: "r", name: brand(name) };
}

/**
 * The identity of a name that an emitter already minted — a graph node, a lock
 * row. The dispatch is safe over such a name, because the fold is idempotent.
 *
 * @param track The ecosystem that holds the name.
 * @param name The name as the emitter wrote it.
 */
export function identityOf(track: Track, name: string): PackageIdentity {
    return track === "python" ? pythonIdentity(name) : rIdentity(name);
}

/**
 * The key of an identity: `<track>:<name>`. Two identities are equal when
 * their keys are equal, thus a map of identities keys on this string.
 */
export function identityKey(identity: PackageIdentity): string {
    return `${identity.track}:${identity.name}`;
}

/**
 * The identity that a key names, or `undefined` when the string is not a key.
 *
 * The FIRST colon splits the two halves. A track name holds no colon, and
 * neither a PEP 503 name nor an R name can hold one, thus `r:GO.db` gives the
 * R identity `GO.db`, dot and all. The name rides through {@link identityOf},
 * and the fold is idempotent, thus a key that {@link identityKey} wrote comes
 * back as the identity that wrote it.
 *
 * The key format is minted here, thus it is read here: a reader that splits
 * the string itself owns a second copy of the format.
 *
 * @param key A `<track>:<name>` string, as {@link identityKey} writes it.
 */
export function parseIdentityKey(key: string): PackageIdentity | undefined {
    const at = key.indexOf(":");
    if (at < 0) return undefined;
    const track = key.slice(0, at);
    const name = key.slice(at + 1);
    if (name === "") return undefined;
    if (track !== "python" && track !== "r") return undefined;
    return identityOf(track, name);
}

/**
 * The store address of an identity: the PEP 503 fold of its name, for both
 * tracks. A store directory is an address and not an identity, thus two
 * identities can share one address — `r:decoupleR` and `python:decoupler`
 * both address as `decoupler`. The pin marker inside the directory carries
 * the identity.
 */
export function identityAddress(identity: PackageIdentity): string {
    return fold(identity.name);
}

/**
 * Why an entry is not a query.
 *
 * - `empty` — the entry names no package.
 * - `location` — a path, a URL, or a store directory. A location is an
 *   installer detail, and the pool resolves names.
 * - `unknown_prefix` — a `<word>:` prefix that is neither `python:` nor `r:`.
 *   Unrefused, such a prefix rides into the pool as part of the name.
 * - `unsupported_specifier` — a specifier that is not `==`. Unrefused, a range
 *   such as `numpy>=1.26` becomes a package name.
 */
export type ParseQueryError =
    | { readonly type: "empty" }
    | { readonly type: "location"; readonly entry: string }
    | { readonly type: "unknown_prefix"; readonly prefix: string; readonly entry: string }
    | { readonly type: "unsupported_specifier"; readonly specifier: string; readonly entry: string };

/**
 * A path, a URL, or a store directory. The entry is trimmed already, thus a
 * leading space cannot defeat the guard.
 */
const LOCATION = /^[.~]|[/\\]|:\/\//;

/** The `<word>:` prefix of an entry. The group holds the word before the colon. */
const PREFIX = /^([A-Za-z][A-Za-z0-9_.-]*):/;

/** A run of specifier characters. Only the exact run `==` names a version. */
const SPECIFIER = /[<>!~=]+/;

/**
 * A run of characters that an exact version cannot hold: a specifier
 * character, a comma, or whitespace. `SPECIFIER` reads the FIRST run only,
 * thus `numpy==1.26,<2` gives the version `1.26,<2` without this guard, and
 * the compound range then rides into the pool as a version string.
 */
const VERSION_INTRUDER = /[<>!~=,\s]+/;

/**
 * Read one entry of the grammar `[python:|r:]<spelling>[==<version>]`.
 *
 * The entry trims once, and the parts keep what the trim left. Every reader of
 * the grammar in the harness calls this function: a second parser would
 * disagree with this one, and the plan validation that passed would then meet
 * a link pass that refuses.
 *
 * @param entry One package entry, as a plan, a tool call, or a host wrote it.
 */
export function parseQuery(entry: string): Result<PackageQuery, ParseQueryError> {
    const trimmed = entry.trim();
    if (trimmed === "") return err({ type: "empty" });
    if (LOCATION.test(trimmed)) return err({ type: "location", entry: trimmed });

    const prefix = PREFIX.exec(trimmed);
    const word = prefix?.[1];
    if (word !== undefined && word !== "python" && word !== "r") {
        return err({ type: "unknown_prefix", prefix: word, entry: trimmed });
    }
    const track: Track | undefined = word === "python" ? "python" : word === "r" ? "r" : undefined;
    const rest = track === undefined ? trimmed : trimmed.slice(track.length + 1);
    if (rest === "") return err({ type: "empty" });

    const specifier = SPECIFIER.exec(rest);
    if (specifier === null) return ok({ spelling: rest, ...(track === undefined ? {} : { track }) });
    if (specifier[0] !== "==") {
        return err({ type: "unsupported_specifier", specifier: specifier[0], entry: trimmed });
    }
    // Both halves trim: `numpy == 1.26.4` is one ask, and an untrimmed half
    // makes the spelling `numpy ` and the version ` 1.26.4`, neither of which
    // any index holds.
    const spelling = rest.slice(0, specifier.index).trim();
    if (spelling === "") return err({ type: "empty" });
    // `name==` names no version, thus the query pins none and the pool answers
    // the newest. The round-trip law holds, because `formatQuery` writes the
    // specifier only beside a version.
    const version = rest.slice(specifier.index + 2).trim();
    const intruder = VERSION_INTRUDER.exec(version);
    if (intruder !== null) {
        return err({ type: "unsupported_specifier", specifier: intruder[0], entry: trimmed });
    }
    return ok({
        spelling,
        ...(track === undefined ? {} : { track }),
        ...(version === "" ? {} : { version }),
    });
}

/**
 * Write a query in the grammar. The prefix rides only beside a track, and
 * `==<version>` only beside a version. For every query,
 * `parseQuery(formatQuery(query))` gives that query again.
 */
export function formatQuery(query: PackageQuery): string {
    const prefix = query.track === undefined ? "" : `${query.track}:`;
    const version = query.version === undefined ? "" : `==${query.version}`;
    return `${prefix}${query.spelling}${version}`;
}

/**
 * What a pool answers about the identities that it holds. Two reads are
 * enough for the ladder, thus a caller builds this over a graph, a lock, or a
 * census without exposing its own shape.
 */
export type PoolIndex = {
    /** Whether the pool holds this exact identity. */
    has: (identity: PackageIdentity) => boolean;
    /**
     * Each R identity of the pool whose address is this fold. The suggestion
     * of an unknown query comes from here: a person who wrote `seurat` meant
     * the R package `Seurat`.
     */
    rIdentitiesFoldingTo: (fold: string) => readonly PackageIdentity[];
};

/**
 * What a query resolves to.
 *
 * - `resolved` — one identity, thus the caller reads the pool under it.
 * - `ambiguous` — one spelling that both tracks hold. The caller refuses, and
 *   the remedy is a prefixed query.
 * - `unknown` — the pool holds no identity of this query. `suggestion` names
 *   the R identity that the caller probably meant.
 */
export type QueryResolution =
    | { readonly kind: "resolved"; readonly identity: PackageIdentity }
    | { readonly kind: "ambiguous"; readonly python: PackageIdentity; readonly r: PackageIdentity }
    | { readonly kind: "unknown"; readonly suggestion?: PackageIdentity };

/**
 * The sole R identity of the pool that folds to this fold, or none. Two such
 * identities give no suggestion, because a guess between them is a coin flip.
 */
function soleRSuggestion(pool: PoolIndex, spellingFold: string): PackageIdentity | undefined {
    const candidates = pool.rIdentitiesFoldingTo(spellingFold);
    return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Resolve one query against a pool.
 *
 * The version takes no part, because the caller holds the versions: the graph
 * orders them, and this function answers which package the query names.
 *
 * The ladder, in order:
 *
 * 1. The query names a track: the identity of that track, when the pool holds
 *    it. Otherwise unknown, with the R suggestion when the track is `r`.
 * 2. The pool holds the R identity of the spelling and the Python identity of
 *    its fold: the R identity when the spelling differs from its fold, because
 *    an uppercase letter or a dot is evidence of an R spelling. Otherwise
 *    ambiguous.
 * 3. The pool holds the R identity: the R identity.
 * 4. The pool holds the Python identity: the Python identity.
 * 5. Exactly one R identity of the pool folds to the fold of the spelling:
 *    unknown, with that identity as the suggestion.
 * 6. Otherwise: unknown.
 *
 * A silent Python-first pick is a fault: it sends `decoupleR` to the Python
 * `decoupler`, and the R package never links.
 */
export function resolveQuery(query: PackageQuery, pool: PoolIndex): QueryResolution {
    const spellingFold = fold(query.spelling);

    if (query.track !== undefined) {
        const identity = identityOf(query.track, query.spelling);
        if (pool.has(identity)) return { kind: "resolved", identity };
        if (query.track !== "r") return { kind: "unknown" };
        const suggestion = soleRSuggestion(pool, spellingFold);
        return suggestion === undefined ? { kind: "unknown" } : { kind: "unknown", suggestion };
    }

    const r = rIdentity(query.spelling);
    const python = pythonIdentity(query.spelling);
    const holdsR = pool.has(r);
    const holdsPython = pool.has(python);

    if (holdsR && holdsPython) {
        return query.spelling === spellingFold ? { kind: "ambiguous", python, r } : { kind: "resolved", identity: r };
    }
    if (holdsR) return { kind: "resolved", identity: r };
    if (holdsPython) return { kind: "resolved", identity: python };

    const suggestion = soleRSuggestion(pool, spellingFold);
    return suggestion === undefined ? { kind: "unknown" } : { kind: "unknown", suggestion };
}
