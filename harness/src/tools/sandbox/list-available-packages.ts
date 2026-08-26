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
 * new analysis is empty. The baked image inventory fragment
 * (`image-packages.txt`, at `/opt/inflexa` in the image) merges into either
 * report when the host can read one. The fragment keeps the section format:
 *
 *     ## System tools (CLI)
 *     samtools, bcftools, ...
 *
 * Each entry renders as `name==version` where the source pins a version, and
 * a targeted `names` lookup also carries the store directory and the full
 * content hash where the source records them. A full listing carries no
 * hashes — a thousand rows of sha256 would bury the signal.
 */

import { readFile } from "node:fs/promises";

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import type { EnvironmentStorePaths, PoolInventoryPackage, PoolInventoryRead, PoolInventorySection } from "../../config/environment-stores.js";
import { capCodePoints, DETAIL_NEEDLE_MAX_LENGTH } from "../../loop/tool-detail.js";
import { LIBS_CONTAINER_PATH } from "../../sandbox/mount-plan.js";
import { readFarmLockFile, type FarmLock } from "../../sandbox/farm.js";

/**
 * Where the lock lives when the host mounts the farm at the same path the
 * sandbox does. Both farm container paths are tried, because the path keys on
 * the declared toolchain (`/mnt/libs/farm` under `"image"`, `/mnt/libs/current`
 * under `"store"`), and the tool does not carry that declaration. A host that
 * reads the farm somewhere else injects its own path instead.
 */
const DEFAULT_FARM_LOCK_FILES = [`${LIBS_CONTAINER_PATH}/farm/inflexa.lock`, `${LIBS_CONTAINER_PATH}/current/inflexa.lock`] as const;

/** Where the baked image inventory fragment lives inside the image. */
const DEFAULT_IMAGE_PACKAGES_FILE = "/opt/inflexa/image-packages.txt";

/** The section title of each known lock track. An unknown track titles itself. */
const TRACK_TITLES: Record<string, string> = {
    python: "Python (pip)",
    cran: "R (CRAN)",
    bioconductor: "R (Bioconductor)",
    github: "R (GitHub)",
    node: "Node (npm)",
};

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
    return [...byTrack.entries()].filter(([, packages]) => packages.length > 0).map(([track, packages]) => ({ title: TRACK_TITLES[track] ?? track, packages }));
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

/** One language track of the store, in `packages.txt` section order. The seam shape and the render shape are one. */
export type Section = PoolInventorySection;

/** One `names` lookup: present + canonical spelling + track + store identity, or absent. */
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
    | { readonly requested: string; readonly present: false };

/**
 * Three shapes, one per call path: the store is unmounted; a `names` presence
 * check; a (possibly filtered) listing bounded by `limit`, whose `total` and
 * `hasMore` make truncation explicit.
 */
export type PackagesResult =
    | { readonly available: false; readonly content: string }
    | { readonly available: true; readonly checked: readonly CheckedPackage[] }
    | { readonly available: true; readonly total: number; readonly returned: number; readonly hasMore: boolean; readonly content: string };

/** The `language` filter values, mapped onto the concrete section headings. */
const LANGUAGE_MATCHERS: Record<string, (title: string) => boolean> = {
    // The R triple: `R (CRAN)`, `R (Bioconductor)`, `R (GitHub)`.
    r: (t) => /^r\b/i.test(t),
    python: (t) => /^python\b/i.test(t),
    // `System tools (CLI)` — the conda-installed bioinformatics executables.
    cli: (t) => /system tools|\bcli\b/i.test(t),
    node: (t) => /^node\b/i.test(t),
};

/**
 * Parse `packages.txt` into its sections. `#` lines are the advisory header,
 * `## X` opens a section, and every other non-empty line contributes
 * comma-separated package names to the open section. Unknown section headings
 * are preserved as-is — a downstream image may add its own track.
 */
export function parsePackagesFile(content: string): Section[] {
    const sections: { title: string; packages: SectionPackage[] }[] = [];
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("##")) {
            sections.push({ title: trimmed.slice(2).trim(), packages: [] });
            continue;
        }
        if (trimmed.startsWith("#")) continue;
        const open = sections.at(-1);
        if (!open) continue;
        for (const name of trimmed.split(",")) {
            const pkg = name.trim();
            if (pkg) open.packages.push({ name: pkg });
        }
    }
    return sections;
}

/** One entry as the listing renders it: `name==version` where the source pins a version, the bare name otherwise. */
function renderPackage(entry: SectionPackage): string {
    return entry.version === undefined ? entry.name : `${entry.name}==${entry.version}`;
}

/** Render sections to the agent-facing listing, bounded at `limit` packages. */
function renderListing(sections: readonly Section[], limit: number): { content: string; returned: number } {
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
        lines.push(`\n## ${section.title}`, `  ${shown.map(renderPackage).join(", ")}`);
        const hidden = section.packages.length - shown.length;
        if (hidden > 0) lines.push(`  … and ${hidden} more in this section (raise \`limit\` or narrow with \`query\`).`);
    }
    return { content: lines.join("\n").trim(), returned };
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
export function queryPackages(sections: readonly Section[], { names, query, language, limit }: PackagesQuery): PackagesResult {
    // Presence check — the cheap, targeted path. Answers "is X available, and in
    // which track" without returning the catalog.
    if (names && names.length > 0) {
        const index = new Map<string, { entry: SectionPackage; section: string }>();
        for (const section of sections) {
            for (const pkg of section.packages) {
                // First writer wins: `packages.txt` sections are ordered, so a name
                // colliding across tracks resolves to the earliest one.
                if (!index.has(pkg.name.toLowerCase())) index.set(pkg.name.toLowerCase(), { entry: pkg, section: section.title });
            }
        }
        const checked = names.map((requested): CheckedPackage => {
            const hit = index.get(requested.trim().toLowerCase());
            if (!hit) return { requested, present: false };
            // `name` echoes the catalog's canonical spelling — R package names are
            // case-sensitive at `library()`, so the exact one is what the caller needs.
            // The store identity rides only where the source records it.
            return {
                requested,
                present: true,
                name: hit.entry.name,
                section: hit.section,
                ...(hit.entry.version === undefined ? {} : { version: hit.entry.version }),
                ...(hit.entry.storeDir === undefined ? {} : { storeDir: hit.entry.storeDir }),
                ...(hit.entry.hash === undefined ? {} : { hash: hit.entry.hash }),
            };
        });
        return { available: true, checked };
    }

    const matchesLanguage = language ? LANGUAGE_MATCHERS[language]! : () => true;
    const needle = query?.trim().toLowerCase();
    const filtered: Section[] = sections
        .filter((s) => matchesLanguage(s.title))
        .map((s) => ({
            title: s.title,
            packages: needle ? s.packages.filter((p) => p.name.toLowerCase().includes(needle)) : s.packages,
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

    const { content, returned } = renderListing(filtered, limit ?? DEFAULT_LIMIT);
    return { available: true, total, returned, hasMore: returned < total, content };
}

export type ListAvailablePackagesDeps = Pick<EnvironmentStorePaths, "farmLockFile" | "imagePackagesFile" | "readPoolInventory">;

/**
 * Create the package inventory over the bound source: the pool-scope reader
 * when the embedder binds one (a conversation or planning surface), the
 * host-readable farm `inflexa.lock` otherwise (a sandbox agent). The image
 * fragment merges into either report.
 */
export function createListAvailablePackagesTool(deps: ListAvailablePackagesDeps = {}) {
    const lockCandidates = deps.farmLockFile ? [deps.farmLockFile] : DEFAULT_FARM_LOCK_FILES;
    const imagePackagesFile = deps.imagePackagesFile ?? DEFAULT_IMAGE_PACKAGES_FILE;
    const readPoolInventory = deps.readPoolInventory;
    // The scope decides the framing sentence: a sandbox agent reads what it can
    // import NOW, and a conversation surface reads what the store HOLDS — a
    // package absent from the pool needs an acquisition, not a shrug.
    const scopeSentence = readPoolInventory
        ? "Query the R, Python, CLI, and Node packages the package pool holds — the set a run can link into an analysis. A package reported present needs no acquisition; a package absent here is not in the store yet. "
        : "Query the R, Python, CLI, and Node packages installed in the sandbox. No packages can be installed at runtime — only what this tool reports is importable. ";
    return defineTool({
        id: "list_available_packages",
        description:
            scopeSentence +
            "A full listing is small (a few hundred packages) and is returned whole by default, so a listing you get back is the complete set unless `hasMore` says otherwise. " +
            '`names`: check specific packages (e.g. ["Seurat", "scanpy"]) — returns present/absent plus the language track for each, case-insensitively; this is the cheapest call and the right one for \'is X available?\'. ' +
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
                    "Check these exact package names for presence (case-insensitive). Returns one entry per name: present/absent + the language track it lives in.",
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
            // The baked image fragment merges in when the host can read one; a
            // missing fragment merges nothing, and that is the normal state for
            // a host that runs outside the image.
            const fragmentSections: Section[] = await readFile(imagePackagesFile, "utf-8")
                .then(parsePackagesFile)
                .catch((): Section[] => []);
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
                return ok(queryPackages([...pool.sections, ...fragmentSections], input));
            }
            let lock: FarmLock | null = null;
            for (const candidate of lockCandidates) {
                lock = readFarmLockFile(candidate).unwrapOr(null);
                if (lock !== null) break;
            }
            if (lock === null) {
                return ok({ available: false, content: UNAVAILABLE_NOTE });
            }
            return ok(queryPackages([...lockSections(lock), ...fragmentSections], input));
        },
    });
}
