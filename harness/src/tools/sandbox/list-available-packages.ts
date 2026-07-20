/**
 * listAvailablePackages — query the R/Python/CLI/Node packages available in the
 * sandbox.
 *
 * The data source is the store's `packages.txt`, assembled by the library-store
 * build (see the lib-store-build spec) and read from wherever the HOST can see
 * it — the container path when the host mounts the same store, an injected path
 * when it does not. Its shape is fixed by the
 * producers (`scripts/lib-store-common.sh`, `images/sandbox-python/inflexa-libs-refresh`):
 * two `#` advisory lines, then one `## <Section>` heading per language track
 * followed by that track's packages as a single comma-separated line.
 *
 *     # Available packages in the sandbox environment.
 *     # Do NOT attempt to install packages — ...
 *
 *     ## R (CRAN)
 *     Seurat, dplyr, ggplot2, ...
 *
 *     ## Python (pip)
 *     anndata, scanpy, ...
 *
 * The file carries **names only — there are no version strings in it**, so this
 * tool reports presence and language track and cannot report a version.
 */

import { readFile } from "node:fs/promises";

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import type { EnvironmentStorePaths } from "../../config/environment-stores.js";

/**
 * Where the list lives when the host mounts the library store at the same path
 * the sandbox does. Hosts that do not — the store is baked into the image and
 * never bind-mounted — inject their own path instead.
 */
const DEFAULT_PACKAGES_FILE = "/mnt/libs/current/packages.txt";

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
    "Package list not available — the library store's inventory could not be read, so what is installed is UNKNOWN. " +
    "Do not assume any package is present, and do not infer one from the analysis you were asked to run. " +
    "Probe each package you intend to use before relying on it (`python3 -c 'import <pkg>'`, " +
    'R `requireNamespace("<pkg>", quietly = TRUE)`) and degrade gracefully when it is absent. ' +
    "Nothing can be installed at runtime.";

/** One language track of the store, in `packages.txt` section order. */
export interface Section {
    /** The section heading verbatim, e.g. `R (CRAN)`, `Python (pip)`. */
    readonly title: string;
    readonly packages: readonly string[];
}

/** One `names` lookup: present + canonical spelling + track, or absent. */
export type CheckedPackage =
    | { readonly requested: string; readonly present: true; readonly name: string; readonly section: string }
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
    const sections: { title: string; packages: string[] }[] = [];
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
            if (pkg) open.packages.push(pkg);
        }
    }
    return sections;
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
        lines.push(`\n## ${section.title}`, `  ${shown.join(", ")}`);
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
        const index = new Map<string, { name: string; section: string }>();
        for (const section of sections) {
            for (const pkg of section.packages) {
                // First writer wins: `packages.txt` sections are ordered, so a name
                // colliding across tracks resolves to the earliest one.
                if (!index.has(pkg.toLowerCase())) index.set(pkg.toLowerCase(), { name: pkg, section: section.title });
            }
        }
        const checked = names.map((requested): CheckedPackage => {
            const hit = index.get(requested.trim().toLowerCase());
            // `name` echoes the catalog's canonical spelling — R package names are
            // case-sensitive at `library()`, so the exact one is what the caller needs.
            return hit ? { requested, present: true, name: hit.name, section: hit.section } : { requested, present: false };
        });
        return { available: true, checked };
    }

    const matchesLanguage = language ? LANGUAGE_MATCHERS[language]! : () => true;
    const needle = query?.trim().toLowerCase();
    const filtered: Section[] = sections
        .filter((s) => matchesLanguage(s.title))
        .map((s) => ({
            title: s.title,
            packages: needle ? s.packages.filter((p) => p.toLowerCase().includes(needle)) : s.packages,
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

export type ListAvailablePackagesDeps = Pick<EnvironmentStorePaths, "packagesFile">;

/** Create the package inventory over a host-readable `packages.txt`. */
export function createListAvailablePackagesTool(deps: ListAvailablePackagesDeps = {}) {
    const packagesFile = deps.packagesFile ?? DEFAULT_PACKAGES_FILE;
    return defineTool({
        id: "list_available_packages",
        description:
            "Query the R, Python, CLI, and Node packages installed in the sandbox. No packages can be installed at runtime — only what this tool reports is importable. " +
            "A full listing is small (a few hundred packages) and is returned whole by default, so a listing you get back is the complete set unless `hasMore` says otherwise. " +
            '`names`: check specific packages (e.g. ["Seurat", "scanpy"]) — returns present/absent plus the language track for each, case-insensitively; this is the cheapest call and the right one for \'is X available?\'. ' +
            "`query`: case-insensitive substring filter over package names. " +
            "`language`: restrict to one track (r | python | cli | node). " +
            "`limit`: cap the packages listed; the response always carries the true `total` and a `hasMore` flag, so truncation is never silent. " +
            'The package list carries NO version numbers — this tool cannot report a package\'s version. Check a version at runtime instead (e.g. `python -c "import scanpy; print(scanpy.__version__)"`).',
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
        execute: async (input): Promise<Result<PackagesResult, ToolError>> => {
            // An unreadable inventory is an expected environment state — model it as an
            // `available: false` data variant telling the caller the set is UNKNOWN.
            let raw: string;
            try {
                raw = await readFile(packagesFile, "utf-8");
            } catch {
                return ok({ available: false, content: UNAVAILABLE_NOTE });
            }
            return ok(queryPackages(parsePackagesFile(raw), input));
        },
    });
}
