/**
 * listAvailablePackages — query the R/Python/CLI/Node packages of the
 * environment, from the inventory source the embedder binds.
 *
 * Two sources exist, one per vantage. A SANDBOX agent reads the
 * `inflexa.lock` of the mounted farm — what a step can import right now —
 * from wherever the HOST can see it: the farm container path when the host
 * mounts the same farm, an injected path when it does not. A CONVERSATION or
 * planning surface reads the pool-scope inventory (`readPoolInventory`) —
 * everything the store holds, whether or not a farm links it yet — because
 * the ask flow marks the packages the POOL does not hold, and the farm of a
 * new analysis is empty. The image inventory record (`image-packages.json`,
 * at the root of the package store) merges into either report when the host
 * can read one: it carries the conda tools and the Node packages the image
 * owns, which the content-addressed store cannot hold.
 *
 * Each entry renders as `name==version` where the source pins a version, and
 * a targeted `names` lookup also carries the store directory and the full
 * content hash where the source records them. A full listing carries no
 * hashes — a thousand rows of sha256 would bury the signal.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import type { EnvironmentStorePaths, PoolInventoryPackage, PoolInventoryRead, PoolInventorySection } from "../../config/environment-stores.js";
import { identityAddress, identityKey, identityOf, resolveQuery, type PackageIdentity, type PoolIndex, type Track } from "../../sandbox/package-identity.js";
import { capCodePoints, DETAIL_NEEDLE_MAX_LENGTH } from "../../loop/tool-detail.js";
import { LIBS_CONTAINER_PATH } from "../../sandbox/mount-plan.js";
import { readFarmLockFile, type FarmLock } from "../../sandbox/farm.js";
import { IMAGE_PACKAGES_FILE, readImagePackagesFile, type ImagePackages } from "../../sandbox/image-packages.js";

/**
 * Where the lock lives when the host mounts the farm at the same path the
 * sandbox does. Both farm container paths are tried, because the path keys on
 * the declared toolchain (`/mnt/libs/farm` under `"image"`, `/mnt/libs/current`
 * under `"store"`), and the tool does not carry that declaration. A host that
 * reads the farm somewhere else injects its own path instead.
 */
const DEFAULT_FARM_LOCK_FILES = [`${LIBS_CONTAINER_PATH}/farm/inflexa.lock`, `${LIBS_CONTAINER_PATH}/current/inflexa.lock`] as const;

/**
 * Where the image inventory record lives: at the root of the package store,
 * which the catalog build copied it into. The default names the container
 * mountpoint of that store, the same rule as {@link DEFAULT_FARM_LOCK_FILES}
 * — a host whose own process sees the store the way a sandbox does needs no
 * configuration. A host that reads the store somewhere else injects
 * `imagePackagesFile`.
 */
const DEFAULT_IMAGE_PACKAGES_FILE = `${LIBS_CONTAINER_PATH}/${IMAGE_PACKAGES_FILE}`;

/**
 * The two headings that a lock track and the image record can both carry.
 * Declared once, because {@link LANGUAGE_MATCHERS} keys the `language` filter
 * of these two on the heading text, and {@link foldSections} merges two
 * sources by it: a second spelling of either would split one track into two
 * headings.
 */
const CLI_TITLE = "System tools (CLI)";
const NODE_TITLE = "Node (npm)";

/** The section title of each known lock track. An unknown track titles itself. */
const TRACK_TITLES: Record<string, string> = {
    python: "Python (pip)",
    cran: "R (CRAN)",
    bioconductor: "R (Bioconductor)",
    github: "R (GitHub)",
    node: NODE_TITLE,
};

/**
 * The ecosystem of one lock subtree. `python` gives the Python track, and
 * `cran`, `bioconductor`, and `github` give the R track — three subtrees of
 * one ecosystem, because a repository is a source and not an identity rule.
 *
 * A subtree that names neither, such as `node`, carries no track: its packages
 * are not in the pool of the two ecosystems, and a `names` lookup matches them
 * by their rendered name.
 */
export function trackOfLockSubtree(subtree: string): Track | undefined {
    if (subtree === "python") return "python";
    return subtree === "cran" || subtree === "bioconductor" || subtree === "github" ? "r" : undefined;
}

/**
 * Group the lock packages into sections, one per track, in a stable order:
 * the known tracks first, then an unknown track at its first occurrence.
 * Each entry keeps the lock's version, store directory, and hash, so the
 * targeted `names` path can report the exact store identity.
 */
export function lockSections(lock: FarmLock): Section[] {
    const byTrack = new Map<string, SectionPackage[]>();
    for (const track of Object.keys(TRACK_TITLES)) byTrack.set(track, []);
    for (const pkg of lock.packages) {
        const entry: SectionPackage = { name: pkg.name, version: pkg.version, storeDir: pkg.store_dir, hash: pkg.hash };
        const open = byTrack.get(pkg.track);
        if (open) open.push(entry);
        else byTrack.set(pkg.track, [entry]);
    }
    return [...byTrack.entries()]
        .filter(([, packages]) => packages.length > 0)
        .map(([subtree, packages]) => {
            const track = trackOfLockSubtree(subtree);
            return { title: TRACK_TITLES[subtree] ?? subtree, packages, ...(track === undefined ? {} : { track }) };
        });
}

/**
 * Group the image record into its two sections, in the order of the record.
 * An empty track yields no section, so the report never carries a heading
 * with nothing under it.
 *
 * A `system_tools` row renders its `executable` name where the record gives
 * one, because an agent invokes the binary rather than the conda package
 * (the manifest `binaries:` map holds the pairs that differ).
 */
export function imageSections(record: ImagePackages): Section[] {
    const sections: Section[] = [];
    if (record.system_tools.length > 0) {
        sections.push({
            title: CLI_TITLE,
            packages: record.system_tools.map((tool) => ({ name: tool.executable ?? tool.name, version: tool.version })),
        });
    }
    if (record.node.length > 0) {
        sections.push({ title: NODE_TITLE, packages: record.node.map((pkg) => ({ name: pkg.name, version: pkg.version })) });
    }
    return sections;
}

/**
 * Merge the sections that share a title, in first-occurrence order, and keep
 * the first entry of each name inside a merged section.
 *
 * Two sources can carry one track: the `node` track of a farm lock and the
 * `node` track of the image record. Rendered as they arrive, a listing would
 * print one heading twice and read as two tracks. The fold keeps the first
 * writer, which is the same rule the `names` index applies, thus the listing
 * and the presence check agree on which entry a colliding name resolves to.
 */
function foldSections(sections: readonly Section[]): Section[] {
    const byTitle = new Map<string, { title: string; track?: Track; packages: SectionPackage[]; seen: Set<string> }>();
    for (const section of sections) {
        let open = byTitle.get(section.title);
        if (!open) {
            open = { title: section.title, track: section.track, packages: [], seen: new Set() };
            byTitle.set(section.title, open);
        }
        for (const pkg of section.packages) {
            if (open.seen.has(pkg.name)) continue;
            open.seen.add(pkg.name);
            open.packages.push(pkg);
        }
    }
    return [...byTitle.values()].map(({ title, track, packages }) => ({ title, packages, ...(track === undefined ? {} : { track }) }));
}

/**
 * Default cap on a listing — high enough that the real store is never truncated.
 * The shipped catalog is ~270 packages (~3 KB, well under a thousand tokens), so
 * a low default bought nothing and cost correctness: a partial listing reads as a
 * complete one, and an agent concludes a package is absent when it was merely not
 * rendered. The cap survives only as a backstop for a downstream `FROM` image
 * that adds a pathological number of packages.
 */
const DEFAULT_LIMIT = 2_000;

/**
 * Naming packages here would be worse than saying nothing: this state means the
 * list could not be read, so any roll-call is a guess the agent has no way to
 * check, and an agent told to "assume numpy is available" will import it and
 * fail at runtime instead of probing first.
 */
const UNAVAILABLE_NOTE =
    "Package list not available — the inventory of the farm could not be read, so what is installed is UNKNOWN. " +
    "Do not assume any package is present, and do not infer one from the analysis you were asked to run. " +
    "Probe each package you intend to use before relying on it (`python3 -c 'import <pkg>'`, " +
    'R `requireNamespace("<pkg>", quietly = TRUE)`) and degrade gracefully when it is absent. ' +
    "Nothing can be installed at runtime.";

/**
 * The pool-scope twin of {@link UNAVAILABLE_NOTE}. It names no runtime probe,
 * because a conversation surface has no runtime to probe, and an unreadable
 * pool must read as UNKNOWN rather than as empty.
 */
const POOL_UNAVAILABLE_NOTE =
    "Package list not available — the package pool could not be read, so what the store holds is UNKNOWN. " +
    "Do not assume a package is present, and do not report a package as absent.";

/** One package entry of a section, with the store identity where the source records it. */
export type SectionPackage = PoolInventoryPackage;

/** One language track of the store, in the section order of its source. The seam shape and the render shape are one. */
export type Section = PoolInventorySection;

/**
 * One hit of a `names` lookup: present + exact spelling + track + store
 * identity, or absent. A name that two sections hold answers with one entry
 * for each of them, thus the array is longer than the `names` array and it is
 * not aligned with it.
 */
export type CheckedPackage =
    | {
          readonly requested: string;
          readonly present: true;
          readonly name: string;
          readonly section: string;
          readonly version?: string;
          readonly storeDir?: string;
          readonly hash?: string;
      }
    | {
          readonly requested: string;
          readonly present: false;
          /**
           * The spelling that the pool does hold, when the resolution finds
           * one. `seurat` misses and `Seurat` is present, thus the answer
           * carries the spelling that a plan and a link both accept.
           */
          readonly suggestion?: string;
      };

/**
 * Three shapes, one per call path: the store is unmounted; a `names` presence
 * check; a (possibly filtered) listing bounded by `limit`, whose `total` and
 * `hasMore` make truncation explicit.
 */
export type PackagesResult =
    | { readonly available: false; readonly content: string }
    | { readonly available: true; readonly checked: readonly CheckedPackage[] }
    | { readonly available: true; readonly total: number; readonly returned: number; readonly hasMore: boolean; readonly content: string };

/**
 * The `language` filter of the two sections that carry no track, mapped onto
 * their concrete headings. The `r` and `python` values read `section.track`
 * instead, because a package track is data and a heading is display text.
 */
const LANGUAGE_MATCHERS: Record<string, (title: string) => boolean> = {
    // `CLI_TITLE` — the conda-installed bioinformatics executables.
    cli: (t) => /system tools|\bcli\b/i.test(t),
    node: (t) => /^node\b/i.test(t),
};

/** Whether one section answers the `language` filter of a call. */
function matchesLanguage(section: Section, language: PackagesQuery["language"]): boolean {
    if (language === undefined) return true;
    if (language === "r" || language === "python") return section.track === language;
    return LANGUAGE_MATCHERS[language]!(section.title);
}

/**
 * The identity names that the Python track and the R track both hold.
 *
 * A plan entry of such a name cannot say which package it means, thus the
 * link pass refuses it as a collision. The listing marks each of these rows
 * with the prefixed forms, and the planner writes one of them. A pair of two
 * spellings, such as `decoupler` and `decoupleR`, needs no mark, because the
 * two identities differ and the spelling settles the track.
 */
function bothTrackNames(sections: readonly Section[]): ReadonlySet<string> {
    const python = new Set<string>();
    const r = new Set<string>();
    for (const section of sections) {
        if (section.track === undefined) continue;
        const holder = section.track === "python" ? python : r;
        for (const pkg of section.packages) holder.add(identityOf(section.track, pkg.name).name);
    }
    return new Set([...python].filter((name) => r.has(name)));
}

/**
 * One entry as the listing renders it: `name==version` where the source pins
 * a version, the bare name otherwise. A name that both tracks hold carries
 * the two forms a plan writes, because a bare entry of it refuses the launch.
 */
function renderPackage(entry: SectionPackage, track: Track | undefined, bothTracks: ReadonlySet<string>): string {
    const rendered = entry.version === undefined ? entry.name : `${entry.name}==${entry.version}`;
    if (track === undefined) return rendered;
    const identity = identityOf(track, entry.name).name;
    return bothTracks.has(identity) ? `${rendered} [both tracks — write python:${identity} or r:${identity}]` : rendered;
}

/** Render sections to the agent-facing listing, bounded at `limit` packages. */
function renderListing(sections: readonly Section[], limit: number, bothTracks: ReadonlySet<string>): { content: string; returned: number } {
    const lines: string[] = [];
    let returned = 0;
    for (const section of sections) {
        if (section.packages.length === 0) continue;
        const room = limit - returned;
        if (room <= 0) {
            lines.push(`\n## ${section.title}`, `  ${section.packages.length} package(s) — not shown (limit reached).`);
            continue;
        }
        const shown = section.packages.slice(0, room);
        returned += shown.length;
        lines.push(`\n## ${section.title}`, `  ${shown.map((entry) => renderPackage(entry, section.track, bothTracks)).join(", ")}`);
        const hidden = section.packages.length - shown.length;
        if (hidden > 0) lines.push(`  … and ${hidden} more in this section (raise \`limit\` or narrow with \`query\`).`);
    }
    return { content: lines.join("\n").trim(), returned };
}

/** One row of a tracked section, with the identity that its track mints. */
type Held = { readonly entry: SectionPackage; readonly section: string; readonly identity: PackageIdentity };

/**
 * A {@link PoolIndex} over the rows of the tracked sections. The suggestion of
 * the ladder reads `rIdentitiesFoldingTo`, and the fold of an identity is its
 * store address — thus the census suggests exactly what the store holds.
 */
function poolIndexOf(held: readonly Held[]): PoolIndex {
    const keys = new Set(held.map((row) => identityKey(row.identity)));
    // Keyed by the identity KEY, not by the address: two R sections can list
    // one package, and a suggestion must count that package once. Two R
    // identities of one address stay two entries, and the ladder then gives no
    // suggestion, because a guess between them is a coin flip.
    const rByKey = new Map<string, PackageIdentity>();
    for (const row of held) {
        if (row.identity.track !== "r") continue;
        rByKey.set(identityKey(row.identity), row.identity);
    }
    return {
        has: (identity) => keys.has(identityKey(identity)),
        rIdentitiesFoldingTo: (fold) => [...rByKey.values()].filter((identity) => identityAddress(identity) === fold),
    };
}

/**
 * One present answer of the `names` path. `name` echoes the spelling that the
 * source records, because an R name is case-sensitive at `library()` and the
 * caller imports that exact one. The store identity rides only where the
 * source records it.
 */
function presentEntry(requested: string, row: { entry: SectionPackage; section: string }): CheckedPackage {
    return {
        requested,
        present: true,
        name: row.entry.name,
        section: row.section,
        ...(row.entry.version === undefined ? {} : { version: row.entry.version }),
        ...(row.entry.storeDir === undefined ? {} : { storeDir: row.entry.storeDir }),
        ...(row.entry.hash === undefined ? {} : { hash: row.entry.hash }),
    };
}

/** The tool's input, as parsed from `inputSchema`. */
export interface PackagesQuery {
    readonly names?: readonly string[];
    readonly query?: string;
    readonly language?: "r" | "python" | "cli" | "node";
    readonly limit?: number;
}

/**
 * Answer a packages query against a parsed catalog. Pure — the tool's `execute`
 * is only the file read plus this call.
 */
export function queryPackages(rawSections: readonly Section[], { names, query, language, limit }: PackagesQuery): PackagesResult {
    const sections = foldSections(rawSections);
    // Presence check — the cheap, targeted path. Answers "is X available, and in
    // which track" without returning the catalog.
    if (names && names.length > 0) {
        // A tracked section holds packages of the pool, thus its rows answer
        // through `resolveQuery` — the same ladder the link of the embedder
        // runs, so the census and the link never disagree. An untracked section
        // (system tools, node packages) holds no package of an ecosystem, thus
        // its rows match their rendered name exactly.
        const held: Held[] = [];
        const exact = new Map<string, { entry: SectionPackage; section: string }[]>();
        for (const section of sections) {
            for (const pkg of section.packages) {
                if (section.track === undefined) {
                    const rows = exact.get(pkg.name) ?? [];
                    rows.push({ entry: pkg, section: section.title });
                    exact.set(pkg.name, rows);
                    continue;
                }
                held.push({ entry: pkg, section: section.title, identity: identityOf(section.track, pkg.name) });
            }
        }
        const pool = poolIndexOf(held);
        const bySection = new Map<string, Held>();
        for (const row of held) if (!bySection.has(identityKey(row.identity))) bySection.set(identityKey(row.identity), row);

        const checked = names.flatMap((requested): CheckedPackage[] => {
            const spelling = requested.trim();
            const hits: CheckedPackage[] = [];
            const resolution = resolveQuery({ spelling }, pool);
            // An ambiguous spelling answers once for each track, because the
            // caller asked about exactly that pair.
            const identities =
                resolution.kind === "resolved" ? [resolution.identity] : resolution.kind === "ambiguous" ? [resolution.python, resolution.r] : [];
            for (const identity of identities) {
                const row = bySection.get(identityKey(identity));
                if (row !== undefined) hits.push(presentEntry(requested, row));
            }
            for (const row of exact.get(spelling) ?? []) {
                hits.push(presentEntry(requested, { entry: row.entry, section: row.section }));
            }
            if (hits.length > 0) return hits;
            const suggestion = resolution.kind === "unknown" ? resolution.suggestion : undefined;
            return [{ requested, present: false, ...(suggestion === undefined ? {} : { suggestion: suggestion.name }) }];
        });
        return { available: true, checked };
    }

    // A browse filter, not an identity rule: the lower case here makes a
    // substring search forgiving, and it never decides which package a name
    // means. The `names` path above owns that decision, and `resolveQuery` is
    // the one place that folds.
    const needle = query?.trim().toLowerCase();
    const filtered: Section[] = sections
        .filter((s) => matchesLanguage(s, language))
        .map((s) => ({
            title: s.title,
            packages: needle ? s.packages.filter((p) => p.name.toLowerCase().includes(needle)) : s.packages,
            ...(s.track === undefined ? {} : { track: s.track }),
        }))
        .filter((s) => s.packages.length > 0);

    const total = filtered.reduce((n, s) => n + s.packages.length, 0);
    if (total === 0) {
        const scope = [language ? `language: ${language}` : null, query ? `query: "${query}"` : null].filter(Boolean).join(", ");
        return {
            available: true,
            total: 0,
            returned: 0,
            hasMore: false,
            content: `No packages match this filter${scope ? ` (${scope})` : ""}. Nothing can be installed at runtime.`,
        };
    }

    // The mark reads every section, not the filtered set: a `language` listing
    // must still say that the other track holds the same name.
    const { content, returned } = renderListing(filtered, limit ?? DEFAULT_LIMIT, bothTrackNames(sections));
    return { available: true, total, returned, hasMore: returned < total, content };
}

export type ListAvailablePackagesDeps = Pick<EnvironmentStorePaths, "farmLockFile" | "imagePackagesFile" | "readPoolInventory"> & {
    /**
     * True when the composition also attaches the `link_packages` tool. The
     * framing sentence must not close the world on the farm then: a package
     * absent from the farm lock can still link in from the pool.
     */
    readonly linkToolPresent?: boolean;
};

/**
 * Create the package inventory over the bound source: the pool-scope reader
 * when the embedder binds one (a conversation or planning surface), the
 * host-readable farm `inflexa.lock` otherwise (a sandbox agent). The image
 * record merges into either report.
 */
export function createListAvailablePackagesTool(deps: ListAvailablePackagesDeps = {}) {
    const lockCandidates = deps.farmLockFile ? [deps.farmLockFile] : DEFAULT_FARM_LOCK_FILES;
    const imagePackagesFile = deps.imagePackagesFile ?? DEFAULT_IMAGE_PACKAGES_FILE;
    const readPoolInventory = deps.readPoolInventory;
    // The scope decides the framing sentence: a sandbox agent reads what it can
    // import NOW, and a conversation surface reads what the store HOLDS — a
    // package absent from the pool needs an acquisition, not a shrug. A sandbox
    // composition with the link seam gets a third framing. There the farm is
    // not the boundary of an import, and a closed-world sentence would send the
    // agent to report a package that one link call supplies.
    const scopeSentence = readPoolInventory
        ? "Query the R, Python, CLI, and Node packages the package pool holds — the set a run can link into an analysis. A package reported present needs no acquisition; a package absent here is not in the store yet. "
        : deps.linkToolPresent
          ? "Query the R, Python, CLI, and Node packages importable in the sandbox right now. Nothing installs at runtime; a package absent here can still be linkable from the host's staged pool — call `link_packages` before treating it as missing. "
          : "Query the R, Python, CLI, and Node packages installed in the sandbox. No packages can be installed at runtime — only what this tool reports is importable. ";
    return defineTool({
        id: "list_available_packages",
        description:
            scopeSentence +
            "A full listing is small (a few hundred packages) and is returned whole by default, so a listing you get back is the complete set unless `hasMore` says otherwise. " +
            '`names`: check specific packages (e.g. ["Seurat", "scanpy"]) — returns present/absent plus the language track for each; this is the cheapest call and the right one for \'is X available?\'. ' +
            "A Python name matches under PEP 503, thus `scikit_learn` reaches `scikit-learn`. An R name matches its DESCRIPTION spelling exactly, thus `seurat` answers absent and carries `Seurat` as the suggestion. " +
            "A name that the Python track and the R track both hold answers once for each track. " +
            "`query`: case-insensitive substring filter over package names. " +
            "`language`: restrict to one track (r | python | cli | node). " +
            "`limit`: cap the packages listed; the response always carries the true `total` and a `hasMore` flag, so truncation is never silent. " +
            "Each entry renders as `name==version` where the source pins a version, and a `names` check also reports the store directory and the content hash where the source records them.",
        inputSchema: z.object({
            names: z
                .array(z.string())
                .max(100)
                .optional()
                .describe(
                    "Check these package names for presence. Returns one entry for each track that holds the name: present/absent + the language track it lives in. An absent name carries the spelling the pool holds, where there is one.",
                ),
            query: z.string().optional().describe("Case-insensitive substring filter over package names."),
            language: z.enum(["r", "python", "cli", "node"]).optional().describe("Restrict results to one language track."),
            limit: z
                .number()
                .int()
                .min(1)
                .max(DEFAULT_LIMIT)
                .optional()
                .describe(
                    `Cap the packages listed. Omit to get the whole set — the store fits well within the ${DEFAULT_LIMIT} ceiling. Ignored when \`names\` is given.`,
                ),
        }),
        // `queryPackages` returns on `names` before it reads another field, thus
        // the presence check comes first. An empty array is not a presence check.
        // `names` are exact identifiers a caller checks for, thus they name the
        // call as they are. A blank query counts as absent, because `queryPackages`
        // trims the needle and applies no filter when nothing is left.
        //
        // A needle rides behind `matching "…"`, because a bare needle reads as a
        // package name. The needle takes its own bound, thus the emit-site cap
        // cannot cut inside the mark and leave the quote open. `language` stays a
        // trailing qualifier, exactly as `execute` treats it.
        describeCall: ({ names, query, language }) => {
            if (names !== undefined && names.length > 0) return names.join(", ");
            const needle = query?.trim();
            if (needle !== undefined && needle !== "") {
                const marked = `matching "${capCodePoints(needle, DETAIL_NEEDLE_MAX_LENGTH)}"`;
                return language === undefined ? marked : `${marked} (${language})`;
            }
            if (language !== undefined) return `${language} packages`;
            return "full package list";
        },
        execute: async (input): Promise<Result<PackagesResult, ToolError>> => {
            // The image record merges in when the host can read a valid one.
            // An absent record and an invalid record both merge nothing, and
            // neither is an error: the record is an enrichment, and the farm
            // or pool inventory stays whole without it. A store packed before
            // the record existed carries none. The tool holds no logger, thus
            // an invalid record cannot be reported here — the schema of the
            // harness refuses it, and the report degrades to the tracks it
            // could read.
            const recordSections: Section[] = readImagePackagesFile(imagePackagesFile).map(imageSections).unwrapOr([]);
            // An unreadable inventory is an expected environment state — model it as an
            // `available: false` data variant telling the caller the set is UNKNOWN,
            // WITH the reason: without it, a structural fault (a damaged dependency
            // graph) reads as a transient flake, and the caller retries for ever.
            if (readPoolInventory) {
                const pool = await readPoolInventory().catch((cause): PoolInventoryRead => ({
                    kind: "unavailable",
                    reason: cause instanceof Error ? cause.message : String(cause),
                }));
                if (pool.kind === "unavailable") return ok({ available: false, content: `${POOL_UNAVAILABLE_NOTE} The reason: ${pool.reason}.` });
                return ok(queryPackages([...pool.sections, ...recordSections], input));
            }
            let lock: FarmLock | null = null;
            for (const candidate of lockCandidates) {
                lock = readFarmLockFile(candidate).unwrapOr(null);
                if (lock !== null) break;
            }
            if (lock === null) {
                return ok({ available: false, content: UNAVAILABLE_NOTE });
            }
            return ok(queryPackages([...lockSections(lock), ...recordSections], input));
        },
    });
}
