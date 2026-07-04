/**
 * Bundle + architecture resolution — the "questions we don't ask" layer.
 *
 * The build change publishes the library store as per-track content-addressed
 * tarballs grouped into two underlying bundles: `python-conda = {python,conda,node}`
 * and `python-r-conda = {python,conda,node,cran,bioconductor,github}` (the R triple
 * is all-or-none). The CLI surfaces just two user-facing choices — `full` and
 * `core` — and infers everything else from `uname -m`. The user never sees tracks,
 * R triples, or architectures; those are our problem (see design.md "Bundles, arch,
 * and the questions we DON'T ask").
 */

/** The supported host architectures — the published-store `<arch>` URL segments. */
export const ARCHES = ["linux-amd64", "linux-arm64"] as const;

/** Host architecture, mapped from `uname -m` onto the published-store arch segment. */
export type Arch = (typeof ARCHES)[number];

/** The two user-facing bundle choices. `full` adds the R stack; `core` is Python-only. */
export type UserBundle = "full" | "core";

/**
 * An underlying store track. Each maps to one content-addressed tarball in the
 * manifest and extracts into one fixed subtree of a version directory
 * (see {@link TRACK_SUBTREE}, which mirrors `harness/src/sandbox/mount-plan.ts`).
 */
export type Track = "python" | "conda" | "node" | "cran" | "bioconductor" | "github";

// TODO(extend): arm64 `full` is deferred upstream (r2u is amd64-only; bioconda
// aarch64 is patchy). When arm64 R tarballs exist, `selectBundle` should stop
// downgrading full→core on arm64 and `resolvableBundles` should offer both.

/**
 * Why the full (R) stack is unavailable on arm64 — the SINGLE source of this
 * user-facing rationale, rendered verbatim by {@link selectBundle}'s downgrade
 * note, `inflexa libs list`, and the `inflexa setup` library-store note (so the
 * explanation never drifts between the three sites). Mentions "arm64" so each
 * caller can surface it as-is.
 */
export const ARM64_NO_R_REASON = "R libraries are not yet built for arm64 (upstream r2u is amd64-only), so the full stack is unavailable there.";

/** The R triple — present only in the full bundle, and never on arm64. */
const R_TRACKS: readonly Track[] = ["cran", "bioconductor", "github"];

/** Non-R tracks — present in every bundle on every arch. */
const BASE_TRACKS: readonly Track[] = ["python", "conda", "node"];

const FULL_TRACKS: readonly Track[] = [...BASE_TRACKS, ...R_TRACKS];
const CORE_TRACKS: readonly Track[] = BASE_TRACKS;

/**
 * User bundle → the manifest bundle segment the build change publishes under
 * (`latest/<manifestBundle>/<arch>/manifest.json`). The URL segment is the
 * underlying track-set name, not the user-facing word.
 */
const MANIFEST_BUNDLE: Record<UserBundle, string> = {
    full: "python-r-conda",
    core: "python-conda",
};

/**
 * Fixed subtree (relative to a version dir) each track extracts into. This is a
 * contract, not a convention: the resolver env in `harness/src/sandbox/mount-plan.ts`
 * hard-codes `/mnt/libs/current/r/{github,bioconductor,cran}`, `.../node/node_modules`,
 * and `.../conda/bin`, so a track MUST land at exactly these roots.
 */
export const TRACK_SUBTREE: Record<Track, string> = {
    cran: "r/cran",
    bioconductor: "r/bioconductor",
    github: "r/github",
    python: "python",
    node: "node",
    conda: "conda",
};

/**
 * Map `uname -m` output onto an {@link Arch}. `null` for an unrecognized machine
 * so the caller can surface an honest "unsupported architecture" rather than
 * guessing wrong. Pure — takes the machine string so it is unit-testable without
 * spawning `uname`.
 */
export function archFromMachine(machine: string): Arch | null {
    const m = machine.trim().toLowerCase();
    if (m === "x86_64" || m === "amd64") return "linux-amd64";
    if (m === "aarch64" || m === "arm64") return "linux-arm64";
    return null;
}

// `uname -m` is stable for a process's lifetime, so the result is memoized: the
// pull/status/list/pre-launch-offer paths each call detectArch 2–4× per command,
// and re-spawning `uname` every time is pure waste. `undefined` = not yet resolved;
// `null` = resolved but unsupported (a genuine cached outcome, not "unresolved").
let cachedArch: Arch | null | undefined;

/** Detect the host architecture via `uname -m`. `null` on an unrecognized machine or a failed spawn. */
export function detectArch(): Arch | null {
    if (cachedArch !== undefined) return cachedArch;
    try {
        cachedArch = archFromMachine(Bun.spawnSync(["uname", "-m"]).stdout.toString());
    } catch {
        // A failed spawn (no `uname` on PATH, exec denied) folds onto the same in-band
        // null as an unrecognized machine — callers already treat null as "unsupported",
        // and the pre-launch offer (pull.ts offerLibStoreIfMissing) must never throw.
        cachedArch = null;
    }
    return cachedArch;
}

/**
 * The default bundle for a bare machine (no store, no argument): `full` on amd64
 * because R is the point of the bioinformatics product; `core` on arm64 because
 * the R tarballs are not built there yet.
 */
export function defaultBundle(arch: Arch): UserBundle {
    return arch === "linux-amd64" ? "full" : "core";
}

/** The bundles a user can actually obtain for this arch — arm64 has no `full`. */
export function resolvableBundles(arch: Arch): UserBundle[] {
    return arch === "linux-amd64" ? ["full", "core"] : ["core"];
}

/** A fully-resolved bundle: what will actually be pulled, plus why if it was downgraded. */
export type ResolvedBundle = {
    /** The bundle actually selected (may differ from the request after a fallback). */
    readonly bundle: UserBundle;
    /** The manifest URL segment for this bundle. */
    readonly manifestBundle: string;
    /** The exact track set to pull. */
    readonly tracks: readonly Track[];
    readonly arch: Arch;
    /**
     * Set when the request was downgraded (full → core on arm64). Carries the
     * user-facing reason so the caller can surface it as a note, not a bare error.
     */
    readonly downgradeReason?: string;
};

/**
 * Resolve a (possibly absent) user request against the detected arch into the
 * concrete track set to pull. An absent request takes the arch default. A `full`
 * request on arm64 is not an error: it is downgraded to `core` with an
 * explanation (R libraries are not yet built for arm64), because from the user's
 * chair "R isn't ready on your machine yet" is a fact to show, not a failure.
 */
export function selectBundle(requested: UserBundle | undefined, arch: Arch): ResolvedBundle {
    const want = requested ?? defaultBundle(arch);

    if (want === "full" && arch === "linux-arm64") {
        return {
            bundle: "core",
            manifestBundle: MANIFEST_BUNDLE.core,
            tracks: CORE_TRACKS,
            arch,
            downgradeReason: `${ARM64_NO_R_REASON} Falling back to the core (Python + conda) stack.`,
        };
    }

    const tracks = want === "full" ? FULL_TRACKS : CORE_TRACKS;
    return { bundle: want, manifestBundle: MANIFEST_BUNDLE[want], tracks, arch };
}
